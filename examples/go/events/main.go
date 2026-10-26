// Sending events from your own code: one, a list, once only, and for later.
// Run: go run ./events
// Needs FLOW_EVENT_KEY (and FLOW_BASE_URL for a local engine). No server needed.
package main

import (
	"context"
	"log"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
)

func main() {
	ctx := context.Background()
	client, err := flow.NewClient(flow.ClientOpts{AppID: "shop"})
	if err != nil {
		log.Fatal(err)
	}

	// #region one
	// One event. The answer is the ID the engine gave it.
	id, err := client.Send(ctx, flow.Event{
		Name: "order/paid",
		Data: map[string]any{"orderId": "o_123", "total": 4200},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println("one event:", id)
	// #endregion one

	// #region many
	// Up to 100 events in one request. All are taken, or none.
	ids, err := client.SendMany(ctx, []flow.Event{
		{Name: "user/signed-up", Data: map[string]any{"userId": "u_1"}},
		{Name: "user/signed-up", Data: map[string]any{"userId": "u_2"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println("two events:", ids)
	// #endregion many

	// #region once
	// The same ID twice: the engine sees one event, with one event ID.
	paid := flow.Event{
		ID:   flow.StrPtr("payment-pi_3Nx"),
		Name: "order/paid",
		Data: map[string]any{"orderId": "o_124"},
	}
	first, err := client.Send(ctx, paid)
	if err != nil {
		log.Fatal(err)
	}
	again, err := client.Send(ctx, paid)
	if err != nil {
		log.Fatal(err)
	}
	log.Println("sent twice:", first, again)
	// #endregion once

	// #region later
	// Timestamp in the future: the runs are made now and start at that time.
	later, err := client.Send(ctx, flow.Event{
		Name:      "cart/reminder",
		Data:      map[string]any{"cartId": "c_9"},
		Timestamp: time.Now().Add(time.Minute).UnixMilli(),
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println("for later:", later)
	// #endregion later

	// #region error
	// A bad event fails the whole request with an error that holds the engine's answer.
	if _, err := client.Send(ctx, flow.Event{Name: "inngest/anything"}); err != nil {
		log.Println("refused:", err)
	}
	// #endregion error
}
