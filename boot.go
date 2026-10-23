package flow

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"time"
)

// The sync at boot: Serve asks the engine for the hash of the app's last sync
// (GET {base}/apps/{appId}/sync?hash=) and PUTs the manifest when its own hash
// is different and the engine's rolling-deploy guard is off, so a deploy needs
// no Resync. Then it checks again every checkEveryMs the engine gives (5 min),
// or at retryAt while the guard is on, until Close. See ClientOpts.NoSyncOnBoot.

// checkTimeout caps one check (the GET and the PUT).
const checkTimeout = 30 * time.Second

// After retryAt the check runs a little later (retrySlack), and never sooner
// than retryFloor after the last one, so a wrong clock or answer can not make
// a tight loop. defaultCheckEvery is the wait after a failed check when the
// engine did not say. Vars so tests can make them short.
var (
	retryFloor        = 5 * time.Second
	retrySlack        = time.Second
	defaultCheckEvery = 5 * time.Minute
)

// What a check did. "waiting": the engine's guard is on, no PUT.
const (
	bootNoKey    = "no-key"
	bootInSync   = "in-sync"
	bootSynced   = "synced"
	bootWaiting  = "waiting"
	bootReplaced = "replaced"
	bootFailed   = "failed"
)

// startBootSync starts the checks once, in the background. It never blocks
// and never fails Serve. They stop on Close.
func (c *Client) startBootSync() {
	if !c.syncOnBoot {
		return
	}
	c.bootOnce.Do(func() {
		go func() {
			defer close(c.bootDone)
			// Close also ends a check that is on its way.
			base, cancelBase := context.WithCancel(context.Background())
			defer cancelBase()
			go func() {
				select {
				case <-c.stop:
					cancelBase()
				case <-base.Done():
				}
			}()
			for {
				ctx, cancel := context.WithTimeout(base, checkTimeout)
				_, next := c.checkSync(ctx)
				cancel()
				if next <= 0 || base.Err() != nil {
					return
				}
				t := time.NewTimer(next)
				select {
				case <-t.C:
				case <-base.Done():
					t.Stop()
					return
				}
			}
		}()
	})
}

// Close stops the sync checks that Serve started. Call it when the server
// shuts down. Serve still answers after Close; it just checks no more.
func (c *Client) Close() {
	c.closeOnce.Do(func() { close(c.stop) })
}

// clampWait keeps a wait between retryFloor and a day.
func clampWait(d time.Duration) time.Duration {
	if d < retryFloor {
		return retryFloor
	}
	if d > 24*time.Hour {
		return 24 * time.Hour
	}
	return d
}

// retryDelay is how long to wait for a retryAt (ms since epoch, the engine's
// clock). It is measured from the engine's Date header when it has one, so
// the app's clock does not matter. 0: no retryAt.
func retryDelay(retryAt *float64, date string, now time.Time) time.Duration {
	if retryAt == nil || math.IsNaN(*retryAt) || math.IsInf(*retryAt, 0) {
		return 0
	}
	if t, err := http.ParseTime(date); err == nil {
		now = t
	}
	return clampWait(time.Duration(*retryAt-float64(now.UnixMilli()))*time.Millisecond + retrySlack)
}

// syncCheck is the engine's answer to GET /apps/{appId}/sync. RetryAt and
// CheckEveryMs are left out by older engines.
type syncCheck struct {
	AppID        string   `json:"appId"`
	ManifestHash *string  `json:"manifestHash"`
	SyncedAt     *int64   `json:"syncedAt"`
	RetryAt      *float64 `json:"retryAt"`
	CheckEveryMs *float64 `json:"checkEveryMs"`
}

// checkSync is one check: the GET, and a PUT of the manifest only when the
// engine's hash is not this app's (null counts as different) and its guard is
// off (retryAt null). The PUT has no URL: there is no request to take it from,
// and the engine keeps the URL it has. It logs what went wrong, and returns
// what it did and when to check again (0: stop).
func (c *Client) checkSync(ctx context.Context) (string, time.Duration) {
	// Without a key there is nothing to sign with (dev mode).
	if c.signingKey == "" {
		return bootNoKey, 0
	}
	prefix := "flow: sync check of app " + c.appID
	heartbeat := time.Duration(0)
	failed := func() (string, time.Duration) {
		if heartbeat > 0 {
			return bootFailed, heartbeat
		}
		return bootFailed, defaultCheckEvery
	}
	bearer, err := signingKeyBearer(c.signingKey)
	if err != nil {
		log.Printf("%s: %v", prefix, err)
		return bootFailed, 0
	}
	// The check sends this copy's hash: the engine then knows copies with it still
	// run, which keeps its rolling-deploy guard on during a gradual deploy.
	m := c.Manifest("")
	u := c.syncURL() + "?hash=" + url.QueryEscape(m.ManifestHash)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		log.Printf("%s: %v", prefix, err)
		return bootFailed, 0
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	status, header, body, err := c.doHeader(req)
	if err != nil {
		log.Printf("%s: the check failed: %v", prefix, err)
		return failed()
	}
	if status == http.StatusNotFound {
		// An engine without this route: stop, it will not have it in 5 minutes either.
		log.Printf("%s: the engine has no sync check (404), so this app syncs only on PUT or Resync", prefix)
		return bootFailed, 0
	}
	if status != http.StatusOK {
		log.Printf("%s: the check failed (%d): %s", prefix, status, engineError(body))
		return failed()
	}
	var stored syncCheck
	if err := json.Unmarshal(body, &stored); err != nil {
		log.Printf("%s: cannot read the check answer: %v", prefix, err)
		return failed()
	}
	if e := stored.CheckEveryMs; e != nil && *e > 0 && !math.IsInf(*e, 0) {
		heartbeat = clampWait(time.Duration(*e) * time.Millisecond)
	}

	if stored.ManifestHash != nil && *stored.ManifestHash == m.ManifestHash {
		return bootInSync, heartbeat
	}
	if stored.RetryAt != nil {
		// The guard is on (an old copy during a deploy, or a rollback): no PUT until it ends.
		wait := retryDelay(stored.RetryAt, header.Get("Date"), c.now())
		log.Printf("%s: the engine has a newer manifest and keeps it for now; checking again in %s", prefix, wait.Round(time.Second))
		return bootWaiting, wait
	}
	status, header, body, err = c.putManifest(ctx, m)
	if err != nil {
		log.Printf("%s: the sync failed: %v", prefix, err)
		return failed()
	}
	if status >= 200 && status < 300 {
		had := "no manifest hash"
		if stored.ManifestHash != nil {
			had = "an older manifest"
		}
		log.Printf("%s: synced (the engine had %s)", prefix, had)
		return bootSynced, heartbeat
	}
	var e struct {
		Code    string   `json:"code"`
		RetryAt *float64 `json:"retryAt"`
	}
	_ = json.Unmarshal(body, &e)
	if status == http.StatusConflict && e.Code == "ManifestReplaced" {
		// The check's answer was out of date: same as retryAt above.
		retry := retryDelay(e.RetryAt, header.Get("Date"), c.now())
		again := ""
		if retry > 0 {
			again = fmt.Sprintf(" (checking again in %s)", retry.Round(time.Second))
		} else {
			retry = heartbeat
		}
		log.Printf("%s: not saved, a newer manifest replaced this one: %s%s", prefix, engineError(body), again)
		return bootReplaced, retry
	}
	hint := ""
	if stored.SyncedAt == nil {
		hint = ". The engine may not know this app's URL yet: add the app by URL in the dashboard, or sync once with curl -X PUT <app-url>"
	}
	log.Printf("%s: the sync failed (%d): %s%s", prefix, status, engineError(body), hint)
	return failed()
}
