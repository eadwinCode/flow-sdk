// Background jobs: the sign-up route answers at once, and a function does the slow
// work (set up the account, send the welcome email) with retries.
// Run: go run ./backgroundjobs
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region function
// SignedUp is the data of a user/signed-up event.
type SignedUp struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
}

func addOnboardUser(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{
			ID: "onboard-user",
			// Each step gets 1 try plus 4 retries (the default). Set it to be sure.
			Retries: flow.IntPtr(4),
			// At most 5 steps of this function run at the same time, over all runs,
			// so a burst of sign-ups does not flood the email provider.
			Concurrency: []flow.Concurrency{{Limit: 5}},
			// And start at most 60 runs a minute.
			Throttle: &flow.Throttle{Limit: 60, Period: time.Minute},
		},
		flow.EventTrigger("user/signed-up", nil),
		func(ctx context.Context, in flow.Input[SignedUp]) (any, error) {
			user := in.Event.Data

			// Safe to run twice: it creates the account only if it is not there yet.
			if _, err := step.Run(ctx, "create-account", func(ctx context.Context) (bool, error) {
				return true, createAccount(ctx, user.UserID)
			}); err != nil {
				return nil, err
			}

			emailID, err := step.Run(ctx, "send-welcome-email", func(ctx context.Context) (string, error) {
				// The key is the same on every try of this step. The email provider
				// uses it to send the email once, even if this step runs again.
				return sendEmail(ctx, user.Email, "welcome", step.IdempotencyKey(ctx))
			})
			if err != nil {
				return nil, err
			}

			if _, err := step.Run(ctx, "mark-onboarded", func(ctx context.Context) (bool, error) {
				return true, markOnboarded(ctx, user.UserID)
			}); err != nil {
				return nil, err
			}

			return map[string]string{"userId": user.UserID, "emailId": emailID}, nil
		},
	)
	return err
}

// #endregion function

// #region route
// signup is your own API. It saves the user, sends one event, and answers. The
// slow work happens later, in the function.
func signup(client *flow.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad JSON", http.StatusBadRequest)
			return
		}
		userID := "user_" + rand.Text()
		saveUser(userID, body.Email)

		_, err := client.Send(r.Context(), flow.Event{
			// The same ID for the same sign-up: if this call is tried again, the
			// engine sees one event, and the function runs once.
			ID:   flow.StrPtr("signup-" + userID),
			Name: "user/signed-up",
			Data: SignedUp{UserID: userID, Email: body.Email},
		})
		if err != nil {
			http.Error(w, "could not queue the sign-up: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"userId": userID})
	}
}

// #endregion route

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "shop"})
	if err != nil {
		log.Fatal(err)
	}
	if err := addOnboardUser(client); err != nil {
		log.Fatal(err)
	}

	http.Handle("/api/flow", client.Serve())
	http.HandleFunc("POST /signup", signup(client))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// ---- Stand-ins for your own database and email provider. ----

var (
	mu    sync.Mutex
	users = map[string]map[string]any{}
	sent  = map[string]string{} // idempotency key -> email ID
	tried = map[string]bool{}
)

func saveUser(userID, email string) {
	mu.Lock()
	defer mu.Unlock()
	users[userID] = map[string]any{"email": email}
}

func createAccount(ctx context.Context, userID string) error {
	mu.Lock()
	defer mu.Unlock()
	if u, ok := users[userID]; ok && u["account"] == nil {
		u["account"] = true
	}
	return nil
}

func markOnboarded(ctx context.Context, userID string) error {
	mu.Lock()
	defer mu.Unlock()
	if u, ok := users[userID]; ok {
		u["onboarded"] = true
	}
	return nil
}

// sendEmail is a pretend email API that fails the first call for each key, as a
// real one sometimes does. The step fails, the engine waits, and the retry works.
func sendEmail(ctx context.Context, to, template, idempotencyKey string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if id, ok := sent[idempotencyKey]; ok {
		return id, nil
	}
	if !tried[idempotencyKey] {
		tried[idempotencyKey] = true
		return "", errors.New("email API answered 503: try again later")
	}
	id := "email_" + rand.Text()
	sent[idempotencyKey] = id
	fmt.Printf("sent %s email to %s\n", template, to)
	return id, nil
}
