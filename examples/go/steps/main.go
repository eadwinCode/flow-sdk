// Functions and steps: every kind of step, in small functions.
// Run: go run ./steps
// Needs FLOW_SIGNING_KEY and FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/group"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region replay
func addReplayDemo(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "replay-demo"},
		flow.EventTrigger("demo/replay", nil),
		func(ctx context.Context, in flow.Input[map[string]any]) (any, error) {
			log.Println("the function starts") // not in a step: runs on every call

			a, err := step.Run(ctx, "step-a", func(ctx context.Context) (int, error) {
				log.Println("step-a runs") // in a step: runs once
				return 1, nil
			})
			if err != nil {
				return nil, err
			}
			b, err := step.Run(ctx, "step-b", func(ctx context.Context) (int, error) {
				log.Println("step-b runs")
				return 2, nil
			})
			if err != nil {
				return nil, err
			}

			log.Println("the function ends")
			return a + b, nil
		},
	)
	return err
}

// #endregion replay

// #region order
// Order is the data of order/placed and order/shipped events.
type Order struct {
	OrderID string `json:"orderId"`
	Total   int    `json:"total"`
	Carrier string `json:"carrier"`
}

func addFulfilOrder(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "fulfil-order"},
		flow.EventTrigger("order/placed", nil),
		func(ctx context.Context, in flow.Input[Order]) (any, error) {
			orderID := in.Event.Data.OrderID

			// Run: do some work once, and keep its result.
			chargeID, err := step.Run(ctx, "charge-card", func(ctx context.Context) (string, error) {
				// The same key on every try of this step: the payment API charges once.
				return chargeCard(ctx, orderID, in.Event.Data.Total, step.IdempotencyKey(ctx))
			})
			if err != nil {
				return nil, err
			}

			// WaitForEvent: pause until order/shipped comes for this order, or 14 days pass.
			shipped, err := step.WaitForEvent[flow.GenericEvent[Order]](ctx, "wait-for-shipment", step.WaitForEventOpts{
				Event:   "order/shipped",
				Match:   flow.StrPtr("data.orderId"), // the new event's data.orderId must equal this one's
				Timeout: 14 * 24 * time.Hour,
			})
			if errors.Is(err, step.ErrEventNotReceived) {
				_, err := step.Run(ctx, "alert-support", func(ctx context.Context) (bool, error) {
					return true, alertSupport(ctx, "order "+orderID+" did not ship in 14 days")
				})
				return map[string]any{"orderId": orderID, "shipped": false}, err
			}
			if err != nil {
				return nil, err
			}

			// Send: send events from a function, once.
			if _, err := step.Send(ctx, "ask-for-review", flow.Event{
				Name: "review/requested",
				Data: map[string]string{"orderId": orderID, "carrier": shipped.Data.Carrier},
			}); err != nil {
				return nil, err
			}

			return map[string]any{"orderId": orderID, "chargeId": chargeID, "shipped": true}, nil
		},
	)
	return err
}

// #endregion order

// #region sleep
// Delivered is the data of an order/delivered event.
type Delivered struct {
	Email string `json:"email"`
}

func addFollowUp(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "follow-up"},
		flow.EventTrigger("order/delivered", nil),
		func(ctx context.Context, in flow.Input[Delivered]) (any, error) {
			email := in.Event.Data.Email

			// Pause for a time.
			if err := step.Sleep(ctx, "wait-3-days", 72*time.Hour); err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "ask-how-it-went", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "How is your order?")
			}); err != nil {
				return nil, err
			}

			// Pause until a moment.
			newYear := time.Date(2027, time.January, 1, 9, 0, 0, 0, time.UTC)
			if err := step.SleepUntil(ctx, "wait-for-new-year", newYear); err != nil {
				return nil, err
			}
			return step.Run(ctx, "send-greetings", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "Happy new year")
			})
		},
	)
	return err
}

// #endregion sleep

// #region invoke
// Invoice is what build-invoice returns.
type Invoice struct {
	URL string `json:"url"`
}

// OrderRef is the data of invoice/requested and order/closed events.
type OrderRef struct {
	OrderID string `json:"orderId"`
	Email   string `json:"email"`
}

func addInvoiceFunctions(client *flow.Client) error {
	// The child: any function can be invoked. Its return value goes back to the caller.
	buildInvoice, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "build-invoice"},
		flow.EventTrigger("invoice/requested", nil),
		func(ctx context.Context, in flow.Input[OrderRef]) (any, error) {
			return step.Run(ctx, "make-pdf", func(ctx context.Context) (Invoice, error) {
				return makeInvoicePDF(ctx, in.Event.Data.OrderID)
			})
		},
	)
	if err != nil {
		return err
	}

	// The parent: starts a run of build-invoice and waits for its result.
	_, err = flow.CreateFunction(client,
		flow.FunctionOpts{ID: "close-order"},
		flow.EventTrigger("order/closed", nil),
		func(ctx context.Context, in flow.Input[OrderRef]) (any, error) {
			invoice, err := step.Invoke[Invoice](ctx, "build-invoice", step.InvokeOpts{
				// The full ID, "<appId>-<functionId>": here "orders-build-invoice".
				FunctionID: buildInvoice.FullyQualifiedID(),
				// Becomes the child's event.data.
				Data: map[string]string{"orderId": in.Event.Data.OrderID},
				// Optional: stop waiting after 1 hour.
				Timeout: time.Hour,
			})
			if err != nil {
				return nil, err
			}
			if _, err := step.Run(ctx, "email-invoice", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, in.Event.Data.Email, "Your invoice: "+invoice.URL)
			}); err != nil {
				return nil, err
			}
			return invoice, nil
		},
	)
	return err
}

// #endregion invoke

// #region parallel
// UserRef is the data of a profile/requested event.
type UserRef struct {
	UserID string `json:"userId"`
}

func addLoadProfile(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "load-profile"},
		flow.EventTrigger("profile/requested", nil),
		func(ctx context.Context, in flow.Input[UserRef]) (any, error) {
			userID := in.Event.Data.UserID
			// Each function runs up to its first new step. The engine then runs both
			// steps at the same time.
			results := group.Parallel(ctx,
				func(ctx context.Context) (any, error) {
					return step.Run(ctx, "load-user", func(ctx context.Context) (string, error) {
						return loadUserName(ctx, userID)
					})
				},
				func(ctx context.Context) (any, error) {
					return step.Run(ctx, "load-orders", func(ctx context.Context) ([]string, error) {
						return loadOrders(ctx, userID)
					})
				},
			)
			if err := results.AnyError(); err != nil {
				return nil, err
			}
			name, orders := results[0].Value.(string), results[1].Value.([]string)
			return map[string]any{"name": name, "orders": len(orders)}, nil
		},
	)
	return err
}

// #endregion parallel

// #region loop
// Rows is the data of an import/started event.
type Rows struct {
	Rows []string `json:"rows"`
}

func addImportRows(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "import-rows"},
		flow.EventTrigger("import/started", nil),
		func(ctx context.Context, in flow.Input[Rows]) (any, error) {
			// The same step ID in a loop is fine: the SDK counts each use.
			for _, row := range in.Event.Data.Rows {
				if _, err := step.Run(ctx, "import-row", func(ctx context.Context) (bool, error) {
					return true, saveRow(ctx, row)
				}); err != nil {
					return nil, err
				}
			}
			return map[string]int{"imported": len(in.Event.Data.Rows)}, nil
		},
	)
	return err
}

// #endregion loop

// #region cancel
// SignedUp is the data of a user/signed-up event.
type SignedUp struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
}

func addOnboarding(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{
			ID: "onboarding",
			// Stop this run when user/deleted comes for the same user.
			CancelOn: []flow.CancelOn{{
				Event:   "user/deleted",
				Match:   flow.StrPtr("data.userId"),
				Timeout: 30 * 24 * time.Hour,
			}},
		},
		flow.EventTrigger("user/signed-up", nil),
		func(ctx context.Context, in flow.Input[SignedUp]) (any, error) {
			email := in.Event.Data.Email
			if _, err := step.Run(ctx, "send-welcome", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "Welcome!")
			}); err != nil {
				return nil, err
			}
			if err := step.Sleep(ctx, "wait-a-week", 7*24*time.Hour); err != nil {
				return nil, err
			}
			return step.Run(ctx, "send-tips", func(ctx context.Context) (bool, error) {
				return true, sendEmail(ctx, email, "Tips for your first week")
			})
		},
	)
	return err
}

// #endregion cancel

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "orders"})
	if err != nil {
		log.Fatal(err)
	}
	for _, add := range []func(*flow.Client) error{
		addReplayDemo, addFulfilOrder, addFollowUp, addInvoiceFunctions, addLoadProfile, addImportRows, addOnboarding,
	} {
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

// ---- Stand-ins for your own code. ----

func chargeCard(ctx context.Context, orderID string, total int, idempotencyKey string) (string, error) {
	log.Printf("charged %d for %s (key %s)", total, orderID, idempotencyKey)
	return "ch_" + orderID, nil
}

func alertSupport(ctx context.Context, text string) error {
	log.Printf("support: %s", text)
	return nil
}

func sendEmail(ctx context.Context, to, text string) error {
	log.Printf("email to %s: %s", to, text)
	return nil
}

func makeInvoicePDF(ctx context.Context, orderID string) (Invoice, error) {
	return Invoice{URL: "https://files.example.com/invoices/" + orderID + ".pdf"}, nil
}

func loadUserName(ctx context.Context, userID string) (string, error) {
	return fmt.Sprintf("User %s", userID), nil
}

func loadOrders(ctx context.Context, userID string) ([]string, error) {
	return []string{userID + "-o1", userID + "-o2"}, nil
}

func saveRow(ctx context.Context, row string) error {
	log.Printf("saved %s", row)
	return nil
}
