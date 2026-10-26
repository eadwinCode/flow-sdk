// Webhooks: your app gets GitHub's webhook, checks its signature, turns it into an
// event, and answers at once. Functions do the work, with retries.
// Run: go run ./webhooks
// Needs FLOW_SIGNING_KEY, FLOW_EVENT_KEY, GITHUB_WEBHOOK_SECRET
// (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region route
func githubWebhook(client *flow.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Read the exact bytes: the signature is over them.
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "could not read the body", http.StatusBadRequest)
			return
		}
		if !validGitHubSignature(body, r.Header.Get("X-Hub-Signature-256")) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}

		kind := r.Header.Get("X-GitHub-Event")        // "push", "pull_request", ...
		delivery := r.Header.Get("X-GitHub-Delivery") // one ID per delivery

		_, err = client.Send(r.Context(), flow.Event{
			// A stable ID: if GitHub sends this delivery again, the engine sees the
			// same event, and each function runs once for it.
			ID:   flow.StrPtr("github-" + delivery),
			Name: "github/" + kind,
			Data: json.RawMessage(body),
		})
		if err != nil {
			// Not queued: answer an error, so GitHub sends it again later.
			log.Printf("could not send the event: %v", err)
			http.Error(w, "try again", http.StatusInternalServerError)
			return
		}

		// Queued. Answer now; the functions do the work.
		_, _ = w.Write([]byte("ok"))
	}
}

func validGitHubSignature(body []byte, header string) bool {
	secret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	if secret == "" || header == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(header), []byte(expected))
}

// #endregion route

// #region functions
// Push is the part of GitHub's push payload these functions read.
type Push struct {
	After      string `json:"after"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	Commits []struct {
		ID string `json:"id"`
	} `json:"commits"`
}

// Two functions on the same event: each push starts one run of each.
func addPushFunctions(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "record-push"},
		flow.EventTrigger("github/push", nil),
		func(ctx context.Context, in flow.Input[Push]) (any, error) {
			push := in.Event.Data
			repo, commits := push.Repository.FullName, len(push.Commits)

			if _, err := step.Run(ctx, "save-push", func(ctx context.Context) (bool, error) {
				return true, savePush(ctx, repo, push.After, commits)
			}); err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "tell-the-team", func(ctx context.Context) (bool, error) {
				return true, postToChat(ctx, fmt.Sprintf("%d new commit(s) in %s", commits, repo))
			}); err != nil {
				return nil, err
			}
			return map[string]any{"repo": repo, "commits": commits}, nil
		},
	)
	if err != nil {
		return err
	}

	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "index-push"},
		flow.EventTrigger("github/push", nil),
		func(ctx context.Context, in flow.Input[Push]) (any, error) {
			return step.Run(ctx, "add-to-search", func(ctx context.Context) (bool, error) {
				return true, addToSearch(ctx, in.Event.Data.Repository.FullName, in.Event.Data.After)
			})
		},
	)
	return err
}

// #endregion functions

// #region wait
// PullRequest is the part of GitHub's pull_request and pull_request_review
// payloads this function reads.
type PullRequest struct {
	Action      string `json:"action"`
	PullRequest struct {
		Number int `json:"number"`
	} `json:"pull_request"`
	Review struct {
		User struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"review"`
}

// When a pull request opens, wait up to 2 days for a review of it. No review:
// remind the team.
func addReviewReminder(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "review-reminder"},
		flow.EventTrigger("github/pull_request", flow.StrPtr("event.data.action == 'opened'")),
		func(ctx context.Context, in flow.Input[PullRequest]) (any, error) {
			review, err := step.WaitForEvent[flow.GenericEvent[PullRequest]](ctx, "wait-for-review", step.WaitForEventOpts{
				Event: "github/pull_request_review",
				// `event` is the event that started this run; `async` is the new one.
				If:      flow.StrPtr("async.data.pull_request.number == event.data.pull_request.number && async.data.repository.id == event.data.repository.id"),
				Timeout: 48 * time.Hour,
			})
			if errors.Is(err, step.ErrEventNotReceived) {
				number := in.Event.Data.PullRequest.Number
				if _, err := step.Run(ctx, "remind-the-team", func(ctx context.Context) (bool, error) {
					return true, postToChat(ctx, fmt.Sprintf("Pull request #%d has no review after 2 days", number))
				}); err != nil {
					return nil, err
				}
				return map[string]any{"reviewed": false}, nil
			}
			if err != nil {
				return nil, err
			}
			return map[string]any{"reviewed": true, "by": review.Data.Review.User.Login}, nil
		},
	)
	return err
}

// #endregion wait

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "integrations"})
	if err != nil {
		log.Fatal(err)
	}
	for _, add := range []func(*flow.Client) error{addPushFunctions, addReviewReminder} {
		if err := add(client); err != nil {
			log.Fatal(err)
		}
	}

	http.Handle("/api/flow", client.Serve())
	http.HandleFunc("POST /webhooks/github", githubWebhook(client))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// ---- Stand-ins for your own database and chat. ----

var (
	mu          sync.Mutex
	pushes      = map[string]int{}
	searchIndex = map[string]bool{}
)

func savePush(ctx context.Context, repo, sha string, commits int) error {
	mu.Lock()
	defer mu.Unlock()
	pushes[sha] = commits // keyed by commit, so a second run changes nothing
	return nil
}

func addToSearch(ctx context.Context, repo, sha string) error {
	mu.Lock()
	defer mu.Unlock()
	searchIndex[repo+"@"+sha] = true // a set: adding twice changes nothing
	return nil
}

func postToChat(ctx context.Context, text string) error {
	log.Printf("chat: %s", text)
	return nil
}
