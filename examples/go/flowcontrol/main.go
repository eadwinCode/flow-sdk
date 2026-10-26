// Flow control: options that decide when, and how many, runs go.
// Run: go run ./flowcontrol
// Needs FLOW_SIGNING_KEY (and FLOW_BASE_URL for a local engine).
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// Data is the event data these functions read.
type Data map[string]any

// options lists each function's ID, trigger event and flow control.
var options = []struct {
	event string
	opts  flow.FunctionOpts
}{
	// #region concurrency
	{"crm/sync", flow.FunctionOpts{
		ID: "sync-crm",
		// At most 5 steps at once per account, and 50 at once in all.
		Concurrency: []flow.Concurrency{
			{Limit: 50},
			{Limit: 5, Key: flow.StrPtr("event.data.accountId")},
		},
	}},
	// #endregion concurrency

	// #region shared-concurrency
	// Two functions share one limit: 10 calls at once to the partner's API, in all.
	{"partner/orders-changed", flow.FunctionOpts{
		ID:          "push-orders",
		Concurrency: []flow.Concurrency{{Limit: 10, Key: flow.StrPtr("'partner-api'"), Scope: "account"}},
	}},
	{"partner/stock-changed", flow.FunctionOpts{
		ID:          "push-stock",
		Concurrency: []flow.Concurrency{{Limit: 10, Key: flow.StrPtr("'partner-api'"), Scope: "account"}},
	}},
	// #endregion shared-concurrency

	// #region throttle
	{"image/uploaded", flow.FunctionOpts{
		ID: "resize-image",
		// Start at most 60 runs a minute per user (one a second), plus 10 at once
		// after a quiet time. Extra runs wait; none are lost.
		Throttle: &flow.Throttle{Limit: 60, Period: time.Minute, Burst: 10, Key: flow.StrPtr("event.data.userId")},
	}},
	// #endregion throttle

	// #region rate-limit
	{"stock/low", flow.FunctionOpts{
		ID: "low-stock-alert",
		// At most one run per product every 4 hours. Extra events start no run.
		RateLimit: &flow.RateLimit{Limit: 1, Period: 4 * time.Hour, Key: flow.StrPtr("event.data.productId")},
	}},
	// #endregion rate-limit

	// #region debounce
	{"document/edited", flow.FunctionOpts{
		ID: "index-document",
		// Wait until a document has had no edits for 5 minutes, then run once, with
		// the last edit. Never wait more than 30 minutes in all.
		Debounce: &flow.Debounce{Period: 5 * time.Minute, Key: flow.StrPtr("event.data.documentId"), Timeout: 30 * time.Minute},
	}},
	// #endregion debounce

	// #region batch
	{"page/clicked", flow.FunctionOpts{
		ID: "save-clicks",
		// Up to 100 events per run, or what came in 10 seconds, per site.
		BatchEvents: &flow.BatchEvents{MaxSize: 100, Timeout: 10 * time.Second, Key: flow.StrPtr("event.data.siteId")},
	}},
	// #endregion batch

	// #region priority
	{"report/requested", flow.FunctionOpts{
		ID:          "generate-report",
		Concurrency: []flow.Concurrency{{Limit: 10}},
		// Runs waiting for a slot: enterprise ones go first, as if they had waited
		// 2 minutes longer.
		Priority: &flow.Priority{Run: flow.StrPtr("event.data.plan == 'enterprise' ? 120 : 0")},
	}},
	// #endregion priority

	// #region idempotency
	{"order/paid", flow.FunctionOpts{
		ID: "send-receipt",
		// One run per order, however many order/paid events come for it.
		Idempotency: flow.StrPtr("event.data.orderId"),
	}},
	// #endregion idempotency

	// #region singleton
	{"search/rebuild", flow.FunctionOpts{
		ID: "rebuild-search",
		// One run at a time per site. While one runs, a new event starts no run.
		Singleton: &flow.Singleton{Key: flow.StrPtr("event.data.siteId"), Mode: "skip"},
	}},
	// #endregion singleton
}

func main() {
	client, err := flow.NewClient(flow.ClientOpts{AppID: "flow-control"})
	if err != nil {
		log.Fatal(err)
	}

	for _, o := range options {
		id := o.opts.ID
		_, err := flow.CreateFunction(client, o.opts, flow.EventTrigger(o.event, nil),
			func(ctx context.Context, in flow.Input[Data]) (any, error) {
				// #region batch-handler
				// With batchEvents, in.Events holds every event of the batch.
				count := len(in.Events)
				// #endregion batch-handler
				return step.Run(ctx, "work", func(ctx context.Context) (int, error) {
					log.Printf("%s: %d event(s)", id, count)
					return count, nil
				})
			},
		)
		if err != nil {
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
