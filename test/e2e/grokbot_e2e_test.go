package hub

// End-to-end test of the Grok Bot plugin on a real hub (copied into server/internal/hub to run; not part of the
// hub's own tests): GROKBOT_PLUGIN_DIR=<the plugin package> GROKBOT_FAKE=<fake-grok.mjs> go test -run TestGrokbotE2E.
import (
	"bufio"
	"log"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGrokbotE2E(t *testing.T) {
	dir, fake := os.Getenv("GROKBOT_PLUGIN_DIR"), os.Getenv("GROKBOT_FAKE")
	if dir == "" || fake == "" {
		t.Skip("GROKBOT_PLUGIN_DIR and GROKBOT_FAKE not set")
	}
	srv := exec.Command("node", fake)
	out, _ := srv.StdoutPipe()
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Process.Kill(); _ = srv.Wait() })
	line, _ := bufio.NewReader(out).ReadString('\n')
	origin := "http://127.0.0.1:" + strings.TrimSpace(strings.TrimPrefix(line, "listening "))

	h, _ := pluginTestHub(t)
	h.logger = log.New(os.Stderr, "hub: ", 0)
	h.initAgents()
	mux := h.routes()
	master := h.cfg.Token
	phone := &client{out: make(chan []byte, 256), subs: map[[2]string]bool{}, role: roleFull}
	h.mu.Lock()
	h.clients[phone] = struct{}{}
	h.mu.Unlock()

	_, pv := call(t, mux, "POST", "/api/v1/plugins/-/preview", master, `{"source": "dir:`+dir+`"}`)
	if pv["preview_id"] == nil {
		t.Fatalf("preview: %v", pv)
	}
	t.Logf("permissions shown before install: %v", pv["permissions"])
	if code, o := call(t, mux, "POST", "/api/v1/plugins/-/install", master,
		fmt.Sprintf(`{"preview_id": %q, "permissions_digest": %q}`, pv["preview_id"], pv["permissions_digest"])); code != 200 {
		t.Fatalf("install: %d %v", code, o)
	}
	_, o := call(t, mux, "GET", "/api/v1/plugins", master, "")
	t.Logf("before the token: %v", o["plugins"])

	_ = os.MkdirAll(h.plugins.reg.DataDir("grokbot"), 0o700)
	if err := os.WriteFile(filepath.Join(h.plugins.reg.DataDir("grokbot"), "GROKBOT_TEST_ORIGIN"), []byte(origin), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, o := call(t, mux, "PUT", "/api/v1/plugins/grokbot/-/secrets/access_token", master, `{"value": "test-token"}`); code != 200 {
		t.Fatalf("secret: %d %v", code, o)
	}
	time.Sleep(3 * time.Second)
	_, o = call(t, mux, "GET", "/api/v1/plugins", master, "")
	t.Logf("after the token: %v", o["plugins"])
	_, o = call(t, mux, "GET", "/api/v1/agents", master, "")
	t.Logf("sources after the token: %v", o["sources"])
	waitLong(t, "Grok Bot sessions in the Agents tab", func() bool {
		_, o := call(t, mux, "GET", "/api/v1/agents/sessions?provider=grok_bot", master, "")
		l, _ := o["sessions"].([]any)
		return len(l) == 1
	})
	_, o = call(t, mux, "GET", "/api/v1/agents", master, "")
	t.Logf("sources: %v", o["sources"])

	id := "grokbot:bot1/"
	path := "/api/v1/agents/sessions/" + url.PathEscape(id)
	_, o = call(t, mux, "GET", path+"/messages?limit=20", master, "")
	if msgs, _ := o["messages"].([]any); len(msgs) != 2 || !strings.Contains(fmt.Sprint(msgs[1]), "hi there") {
		t.Fatalf("history: %v", o)
	}

	if code, o := call(t, mux, "POST", path+"/messages", master, `{"text": "write me a haiku"}`); code != 200 {
		t.Fatalf("send: %d %v", code, o)
	}
	var sent struct{ Sent []map[string]any }
	r, _ := http.Get(origin + "/_test/sent")
	_ = json.NewDecoder(r.Body).Decode(&sent)
	r.Body.Close()
	if len(sent.Sent) != 1 || sent.Sent[0]["text"] != "write me a haiku" || sent.Sent[0]["agentId"] != "bot1" {
		t.Fatalf("what reached Grok Bot: %v", sent.Sent)
	}

	// The reply is written in two steps on the watch: each one reaches the phone as a push, at once.
	for len(phone.out) > 0 {
		<-phone.out
	}
	start := time.Now()
	var lat []time.Duration
	for _, txt := range []string{"Autumn moonlight—", "Autumn moonlight— / a worm digs silently / into the chestnut."} {
		pushed := time.Now()
		b, _ := json.Marshal(map[string]any{"botId": "bot1", "sessionId": "", "entryId": "e3", "seq": 3, "text": txt})
		r, err := http.Post(origin+"/_test/reply", "application/json", strings.NewReader(string(b)))
		if err != nil {
			t.Fatal(err)
		}
		var rr map[string]any
		_ = json.NewDecoder(r.Body).Decode(&rr)
		r.Body.Close()
		if rr["watchers"].(float64) < 1 {
			t.Fatalf("the plugin is not watching the session: %v", rr)
		}
		deadline := time.After(5 * time.Second)
	wait:
		for {
			select {
			case m := <-phone.out:
				if strings.Contains(string(m), `"type":"agents"`) && strings.Contains(string(m), id) {
					lat = append(lat, time.Since(pushed))
					break wait
				}
			case <-deadline:
				t.Fatalf("no push to the phone for %q", txt)
			}
		}
		_, o = call(t, mux, "GET", path+"/messages?limit=20", master, "")
		msgs, _ := o["messages"].([]any)
		if len(msgs) != 3 || !strings.Contains(fmt.Sprint(msgs[2]), txt) {
			t.Fatalf("after %q: %v", txt, o)
		}
	}
	t.Logf("reply pushed to the phone after %v and %v (whole run %v)", lat[0], lat[1], time.Since(start))
	_, o = call(t, mux, "GET", "/api/v1/agents/sessions?provider=grok_bot", master, "")
	if s := o["sessions"].([]any)[0].(map[string]any); s["unreadCount"].(float64) < 1 {
		t.Fatalf("unread: %v", s)
	}
	if code, _ := call(t, mux, "POST", path+"/read", master, ""); code != 200 {
		t.Fatal("read", code)
	}
}
