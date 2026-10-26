// Crons and scheduled jobs: a nightly report, a weekly digest sent per user, a
// reminder at a set time, and emails timed around a trial's end.
// Run: go run ./crons
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region nightly
// Timer is the data of the event a cron run gets (inngest/scheduled.timer).
type Timer struct {
	Cron        string `json:"cron"`
	ScheduledAt int64  `json:"scheduledAt"` // ms since 1970
}

func addNightlyReport(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "nightly-report"},
		// 02:00 every day, Paris time. Without TZ=..., the time is UTC.
		flow.CronTrigger("TZ=Europe/Paris 0 2 * * *"),
		func(ctx context.Context, in flow.Input[Timer]) (any, error) {
			// The time this run was planned for. Use it, not the clock: a run can
			// start a little late, or be retried later.
			day := time.UnixMilli(in.Event.Data.ScheduledAt).UTC().Format("2006-01-02")

			total, err := step.Run(ctx, "build-report", func(ctx context.Context) (int, error) {
				return buildReport(ctx, day)
			})
			if err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "email-report", func(ctx context.Context) (bool, error) {
				return true, emailReport(ctx, day, total)
			}); err != nil {
				return nil, err
			}
			return map[string]any{"day": day, "total": total}, nil
		},
	)
	return err
}

// #endregion nightly

// #region fan-out
// One cron run lists the users and sends one event per user. Each user then
// gets a run of their own, with its own retries.
func addWeeklyDigest(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "weekly-digest"},
		flow.CronTrigger("TZ=UTC 0 7 * * MON"), // Mondays at 07:00 UTC
		func(ctx context.Context, in flow.Input[Timer]) (any, error) {
			userIDs, err := step.Run(ctx, "list-users", func(ctx context.Context) ([]string, error) {
				return listDigestUsers(ctx)
			})
			if err != nil {
				return nil, err
			}

			// Up to 100 events per step.Send, so send them in chunks, each its own step.
			for i := 0; i < len(userIDs); i += 100 {
				chunk := userIDs[i:min(i+100, len(userIDs))]
				events := make([]flow.Event, 0, len(chunk))
				for _, id := range chunk {
					events = append(events, flow.Event{Name: "digest/send", Data: map[string]string{"userId": id}})
				}
				if _, err := step.Send(ctx, fmt.Sprintf("send-chunk-%d", i/100), events...); err != nil {
					return nil, err
				}
			}
			return map[string]int{"users": len(userIDs)}, nil
		},
	)
	if err != nil {
		return err
	}

	type Digest struct {
		UserID string `json:"userId"`
	}
	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "send-digest", Concurrency: []flow.Concurrency{{Limit: 10}}},
		flow.EventTrigger("digest/send", nil),
		func(ctx context.Context, in flow.Input[Digest]) (any, error) {
			return step.Run(ctx, "send-digest-email", func(ctx context.Context) (bool, error) {
				return true, sendDigestEmail(ctx, in.Event.Data.UserID)
			})
		},
	)
	return err
}

// #endregion fan-out

// #region at-a-time
// Reminder is the data of a reminder/due event.
type Reminder struct {
	UserID string `json:"userId"`
	Text   string `json:"text"`
}

// A run that starts at a set time: send the event now, with Timestamp in the future.
func addSendReminder(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "send-reminder"},
		flow.EventTrigger("reminder/due", nil),
		func(ctx context.Context, in flow.Input[Reminder]) (any, error) {
			return step.Run(ctx, "send-reminder", func(ctx context.Context) (bool, error) {
				return true, notify(ctx, in.Event.Data.UserID, in.Event.Data.Text)
			})
		},
	)
	return err
}

func reminders(client *flow.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			UserID string    `json:"userId"`
			Text   string    `json:"text"`
			At     time.Time `json:"at"` // "2026-11-02T09:00:00Z"
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad JSON", http.StatusBadRequest)
			return
		}
		id, err := client.Send(r.Context(), flow.Event{
			Name:      "reminder/due",
			Data:      Reminder{UserID: body.UserID, Text: body.Text},
			Timestamp: body.At.UnixMilli(), // the run waits, queued, until this time
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"eventId": id})
	}
}

// #endregion at-a-time

// #region trial
// Trial is the data of a trial/started event.
type Trial struct {
	UserID string    `json:"userId"`
	EndsAt time.Time `json:"endsAt"`
}

// Emails timed around a trial's end. Ends early if the user pays.
func addTrialEmails(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{
			ID:       "trial-emails",
			CancelOn: []flow.CancelOn{{Event: "trial/converted", Match: flow.StrPtr("data.userId")}},
		},
		flow.EventTrigger("trial/started", nil),
		func(ctx context.Context, in flow.Input[Trial]) (any, error) {
			trial := in.Event.Data

			if err := step.SleepUntil(ctx, "wait-until-3-days-left", trial.EndsAt.Add(-72*time.Hour)); err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "send-ending-soon", func(ctx context.Context) (bool, error) {
				return true, notify(ctx, trial.UserID, "Your trial ends in 3 days")
			}); err != nil {
				return nil, err
			}

			if err := step.SleepUntil(ctx, "wait-until-the-end", trial.EndsAt); err != nil {
				return nil, err
			}
			return step.Run(ctx, "end-trial", func(ctx context.Context) (bool, error) {
				return true, endTrial(ctx, trial.UserID)
			})
		},
	)
	return err
}

// #endregion trial

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "reports"})
	if err != nil {
		log.Fatal(err)
	}
	for _, add := range []func(*flow.Client) error{addNightlyReport, addWeeklyDigest, addSendReminder, addTrialEmails} {
		if err := add(client); err != nil {
			log.Fatal(err)
		}
	}

	http.Handle("/api/flow", client.Serve())
	http.HandleFunc("POST /reminders", reminders(client))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// ---- Stand-ins for your own code. ----

func buildReport(ctx context.Context, day string) (int, error) {
	log.Printf("building the report for %s", day)
	return 42, nil
}

func emailReport(ctx context.Context, day string, total int) error {
	log.Printf("report for %s: %d", day, total)
	return nil
}

func listDigestUsers(ctx context.Context) ([]string, error) {
	ids := make([]string, 120)
	for i := range ids {
		ids[i] = fmt.Sprintf("user_%d", i+1)
	}
	return ids, nil
}

func sendDigestEmail(ctx context.Context, userID string) error {
	log.Printf("digest sent to %s", userID)
	return nil
}

func notify(ctx context.Context, userID, text string) error {
	log.Printf("to %s: %s", userID, text)
	return nil
}

func endTrial(ctx context.Context, userID string) error {
	log.Printf("trial ended for %s", userID)
	return nil
}
