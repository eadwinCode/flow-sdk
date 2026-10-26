# What is Clevix Flow

Clevix Flow runs code for your app in the background, and makes sure it finishes.
You write **functions** in your app with the SDK. The **engine** decides when each
function runs, calls your app to run it, and keeps track of what is done.

The point: if your app crashes, an outside API is down, or a deploy happens in the
middle, the work is not lost. The engine tries again from where it stopped.

## The moving parts

There are three:

| Part | What it is | Who runs it |
| --- | --- | --- |
| **Your app** | Your own server or Worker, with the SDK (`@clevix/flow` for TypeScript, `github.com/eadwinCode/flow-sdk` for Go). It holds your functions and serves **one HTTP endpoint**, for example `/api/flow`. | You |
| **The engine** | The service that takes events, starts runs, calls your endpoint for each step, saves each result, waits, and retries. It is at `https://worker.flow.clevixstudio.com`. | Clevix |
| **The dashboard** | A website to make your keys, add your apps, and see every run, step and event. It is at [dashboard.flow.clevixstudio.com](https://dashboard.flow.clevixstudio.com). | Clevix |

Your code never runs inside the engine. The engine only calls your endpoint, and
your app runs the code. So your functions can use your database, your files and your
secrets as any other code in your app does.

## How a run happens

Say your app has a function that sends a welcome email when a user signs up.

1. Your sign-up route sends an **event** to the engine: a small JSON message named
   `user/signed-up`, with the user's ID.
2. The engine saves the event and answers at once with its ID. Your route answers
   the user.
3. The engine finds every function whose **trigger** is `user/signed-up`, and starts
   one **run** of each.
4. The engine calls your endpoint with a signed `POST`: "run this function, for this
   event, and here is what is done so far".
5. Your app runs the function from the top. It reaches the first **step** that is not
   done yet, runs it, and answers with the step's result.
6. The engine saves that result, and calls your endpoint again for the next step.
   This goes on until the function returns.
7. If a step fails, the engine waits a little and calls again. Steps that are done
   are not run again: the engine sends their saved results.
8. If a step says "sleep for 3 days" or "wait for another event", the engine stops
   calling. It calls again when the time comes or the event arrives.

Each call to your endpoint is signed with your app's **signing key**, and the SDK
checks the signature, so only the engine can start your functions.

## How the engine learns your functions

The engine must know which functions your app has, and what starts each one. This
is called **sync**. The SDK sends the list of your functions (the **manifest**) to
the engine:

- the first time, when you add the app in the dashboard (**Add app**, then
  **Connect**);
- and after each deploy, by itself, when the app starts.

[Going to production](production.md#sync-on-every-deploy) has the details.

## What it is good for

- [Background jobs](background-jobs.md): slow work moved out of a request, with
  retries.
- [Webhooks and events](webhooks.md): work that starts when something happens, here
  or in another service.
- [Crons and scheduled jobs](crons.md): work on a timetable, or at a set time.

## What it is not

- It is not a queue you read from. You do not poll for work: the engine calls you.
- It does not host your code. Your app runs where it runs today.
- It does not give you a public webhook URL. Webhooks from other services go to a
  route in your own app, which sends an event. See [Webhooks and events](webhooks.md).

Next: [Core ideas](core-ideas.md).
