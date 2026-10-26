// Quick start: one function, served by net/http.
// Run: go run ./quickstart
// Needs FLOW_SIGNING_KEY, and FLOW_BASE_URL when you use a local engine.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	flow "github.com/eadwinCode/flow-sdk"
	"github.com/eadwinCode/flow-sdk/step"
)

// #region function
// Hello is the shape of the event's data.
type Hello struct {
	Name string `json:"name"`
}

func addHelloWorld(client *flow.Client) error {
	_, err := flow.CreateFunction(client,
		flow.FunctionOpts{ID: "hello-world"},
		flow.EventTrigger("demo/hello", nil),
		func(ctx context.Context, in flow.Input[Hello]) (any, error) {
			greeting, err := step.Run(ctx, "make-greeting", func(ctx context.Context) (string, error) {
				return fmt.Sprintf("Hello, %s!", in.Event.Data.Name), nil
			})
			if err != nil {
				return nil, err
			}

			if err := step.Sleep(ctx, "wait-a-moment", 10*time.Second); err != nil {
				return nil, err
			}

			_, err = step.Run(ctx, "print-greeting", func(ctx context.Context) (bool, error) {
				log.Println(greeting)
				return true, nil
			})
			if err != nil {
				return nil, err
			}

			return map[string]string{"greeting": greeting}, nil
		},
	)
	return err
}

// #endregion function

func main() {
	// #region client
	// The app ID names this app on the engine. Keep it the same forever.
	client, err := flow.NewClient(flow.ClientOpts{AppID: "quickstart"})
	if err != nil {
		log.Fatal(err)
	}
	// #endregion client
	if err := addHelloWorld(client); err != nil {
		log.Fatal(err)
	}

	// #region serve
	// One endpoint for all functions. The engine calls it to run your code.
	// Make every function before you call Serve.
	http.Handle("/api/flow", client.Serve())

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("listening on http://127.0.0.1:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
	// #endregion serve
}
