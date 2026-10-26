// Errors and retries: what happens when code fails, and how to change it.
// Run: go run ./errors
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region compensate
// Checkout is the data of an order/checkout event.
type Checkout struct {
	OrderID string `json:"orderId"`
	Card    string `json:"card"`
}

func addChargeOrder(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "charge-order", Retries: flow.IntPtr(3)},
		flow.EventTrigger("order/checkout", nil),
		func(ctx context.Context, in flow.Input[Checkout]) (any, error) {
			holdID, err := step.Run(ctx, "hold-stock", func(ctx context.Context) (string, error) {
				return holdStock(ctx, in.Event.Data.OrderID)
			})
			if err != nil {
				return nil, err
			}

			_, err = step.Run(ctx, "charge-card", func(ctx context.Context) (string, error) {
				return chargeCard(ctx, in.Event.Data.Card, step.IdempotencyKey(ctx))
			})
			if err != nil {
				// A *step.StepError means the step failed for good: no tries are left.
				var failed *step.StepError
				if !errors.As(err, &failed) {
					return nil, err
				}
				// Undo the earlier step, in a step of its own.
				if _, err := step.Run(ctx, "release-stock", func(ctx context.Context) (bool, error) {
					return true, releaseStock(ctx, holdID)
				}); err != nil {
					return nil, err
				}
				return map[string]string{"status": "payment-failed", "reason": failed.Message}, nil
			}

			return map[string]string{"status": "paid"}, nil
		},
	)
	return err
}

// #endregion compensate

// #region retry-after
// Contacts is the data of a crm/contacts-changed event.
type Contacts struct {
	ContactIDs []string `json:"contactIds"`
}

func addPushContacts(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "push-contacts"},
		flow.EventTrigger("crm/contacts-changed", nil),
		func(ctx context.Context, in flow.Input[Contacts]) (any, error) {
			return step.Run(ctx, "push-to-crm", func(ctx context.Context) (int, error) {
				status, retryAfter, updated := crmUpdate(ctx, in.Event.Data.ContactIDs)
				if status == http.StatusTooManyRequests {
					// Try this step again when the API says, not on the normal schedule.
					return 0, flow.RetryAtError(errors.New("the CRM is rate limiting us"), time.Now().Add(retryAfter))
				}
				return updated, nil
			})
		},
	)
	return err
}

// #endregion retry-after

// #region on-failure
// Import is the data of an import/requested event.
type Import struct {
	File string `json:"file"`
}

func addImportUsers(client *flow.Client) error {
	importUsers, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "import-users"},
		flow.EventTrigger("import/requested", nil),
		func(ctx context.Context, in flow.Input[Import]) (any, error) {
			rows, err := step.Run(ctx, "read-file", func(ctx context.Context) ([]string, error) {
				return readFile(ctx, in.Event.Data.File)
			})
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				// Trying again can not help: fail now, with no more retries.
				return nil, flow.NoRetryError(fmt.Errorf("%s is empty", in.Event.Data.File))
			}
			return map[string]int{"rows": len(rows)}, nil
		},
	)
	if err != nil {
		return err
	}

	// Go has no onFailure option: make a second function on the event the engine
	// sends when a run fails for good, for this function only.
	type Failed struct {
		FunctionID string `json:"function_id"` // "<appId>-<functionId>"
		RunID      string `json:"run_id"`
		Error      struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		} `json:"error"`
		Event flow.GenericEvent[Import] `json:"event"` // the event that started the failed run
	}
	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "import-users-failure"},
		flow.EventTrigger("inngest/function.failed",
			flow.StrPtr("event.data.function_id == '"+importUsers.FullyQualifiedID()+"'")),
		func(ctx context.Context, in flow.Input[Failed]) (any, error) {
			failed := in.Event.Data
			return step.Run(ctx, "alert-the-team", func(ctx context.Context) (bool, error) {
				return true, postToChat(ctx, fmt.Sprintf("import of %s failed: %s", failed.Event.Data.File, failed.Error.Message))
			})
		},
	)
	return err
}

// #endregion on-failure

// #region timeouts
// ExportRequest is the data of an export/requested event.
type ExportRequest struct {
	AccountID string `json:"accountId"`
}

func addExportData(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{
			ID: "export-data",
			Timeouts: &flow.Timeouts{
				Step:   2 * time.Minute, // one call to your app may take up to 2 minutes
				Finish: time.Hour,       // the whole run may take up to 1 hour, then it is cancelled
			},
		},
		flow.EventTrigger("export/requested", nil),
		func(ctx context.Context, in flow.Input[ExportRequest]) (any, error) {
			return step.Run(ctx, "export", func(ctx context.Context) (string, error) {
				return runExport(ctx, in.Event.Data.AccountID)
			})
		},
	)
	return err
}

// #endregion timeouts

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "billing"})
	if err != nil {
		log.Fatal(err)
	}
	for _, add := range []func(*flow.Client) error{addChargeOrder, addPushContacts, addImportUsers, addExportData} {
		if err := add(client); err != nil {
			log.Fatal(err)
		}
	}

	http.Handle("/api/flow", client.Serve())
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// ---- Stand-ins for your own code and outside APIs. ----

func holdStock(ctx context.Context, orderID string) (string, error) {
	return "hold_" + orderID, nil
}

func releaseStock(ctx context.Context, holdID string) error {
	log.Printf("released %s", holdID)
	return nil
}

func chargeCard(ctx context.Context, card, idempotencyKey string) (string, error) {
	switch card {
	case "declined":
		return "", flow.NoRetryError(errors.New("the card was declined"))
	case "flaky":
		return "", errors.New("the payment API timed out")
	}
	return "ch_" + idempotencyKey[len(idempotencyKey)-8:], nil
}

var crmCalls atomic.Int32

// crmUpdate is a pretend API: the first call is rate limited.
func crmUpdate(ctx context.Context, contactIDs []string) (status int, retryAfter time.Duration, updated int) {
	if crmCalls.Add(1) == 1 {
		return http.StatusTooManyRequests, 20 * time.Second, 0
	}
	return http.StatusOK, 0, len(contactIDs)
}

func readFile(ctx context.Context, file string) ([]string, error) {
	if len(file) >= 5 && file[:5] == "empty" {
		return []string{}, nil
	}
	return []string{"row 1", "row 2"}, nil
}

func postToChat(ctx context.Context, text string) error {
	log.Printf("chat: %s", text)
	return nil
}

func runExport(ctx context.Context, accountID string) (string, error) {
	return "https://files.example.com/exports/" + accountID + ".csv", nil
}
