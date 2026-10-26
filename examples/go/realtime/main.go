// Realtime: a function sends progress to the browser while it runs.
// Run: go run ./realtime
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine). The engine needs
// realtime turned on (REALTIME_TOKEN_SECRET).
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region publish
// Build is the data of a site/build-requested event.
type Build struct {
	DeploymentID string `json:"deploymentId"`
}

// Progress is what the browser gets.
type Progress struct {
	Pct   int    `json:"pct"`
	Label string `json:"label"`
}

func addBuildSite(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "build-site"},
		flow.EventTrigger("site/build-requested", nil),
		func(ctx context.Context, in flow.Input[Build]) (any, error) {
			id := in.Event.Data.DeploymentID
			channel := "deployment:" + id

			// A failed publish must not fail the step: log it and go on.
			progress := func(ctx context.Context, pct int, label string) {
				if err := client.Realtime().Publish(ctx, channel, "progress", Progress{pct, label}); err != nil {
					log.Printf("realtime publish failed: %v", err)
				}
			}

			if _, err := step.Run(ctx, "render", func(ctx context.Context) (bool, error) {
				progress(ctx, 10, "Rendering")
				return true, render(ctx, id)
			}); err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "upload", func(ctx context.Context) (bool, error) {
				progress(ctx, 60, "Uploading")
				return true, upload(ctx, id)
			}); err != nil {
				return nil, err
			}

			// After the last step, this runs only on the run's last call. So it is
			// sent once, unless that call fails and the engine tries it again.
			progress(ctx, 100, "Done")
			return nil, nil
		},
	)
	return err
}

// #endregion publish

// #region token
// realtimeToken is your own route. Check that this user may see this deployment
// first: the engine does not know your users.
func realtimeToken(client *flow.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !userMaySee(r, id) {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		token, err := client.Realtime().Token(r.Context(), "deployment:"+id, "progress")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(token)
	}
}

// #endregion token

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "sites"})
	if err != nil {
		log.Fatal(err)
	}
	if err := addBuildSite(client); err != nil {
		log.Fatal(err)
	}

	http.Handle("/api/flow", client.Serve())
	http.HandleFunc("GET /api/deployments/{id}/realtime-token", realtimeToken(client))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// ---- Stand-ins for your own code. ----

func userMaySee(r *http.Request, deploymentID string) bool {
	return r.Header.Get("Authorization") != "" && deploymentID != "" // check your session here
}

func render(ctx context.Context, id string) error {
	time.Sleep(time.Second)
	log.Printf("rendered %s", id)
	return nil
}

func upload(ctx context.Context, id string) error {
	time.Sleep(time.Second)
	log.Printf("uploaded %s", id)
	return nil
}
