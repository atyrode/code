package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── colourisers ──────────────────────────────────────────────────────────────
func lvl(s string) int {
	switch s {
	case "minimal":
		return 0
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	case "xhigh":
		return 4
	}
	return 5
}

func shortModel(name string) string {
	if name == "gpt-5.4" {
		return name
	}
	// Slash-scoped ids display without their provider path, and keep their
	// full model part — the vendor's own naming is the recognizable bit.
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
		if !strings.HasPrefix(name, "claude") {
			return name
		}
	}
	p := strings.Split(name, "-")
	if strings.HasPrefix(name, "claude") && len(p) > 1 {
		return p[1]
	}
	return p[len(p)-1]
}

func clampByte(x float64) int {
	v := int(x)
	if v > 255 {
		return 255
	}
	if v < 0 {
		return 0
	}
	return v
}

// modelLabel is how a routing token's model name is displayed: the short key
// ("opus") by default, the catalog's own full id ("claude-opus-5") while the
// reveal toggle is on — the sanity check for "which model is this actually".
func (m model) modelLabel(name string) string {
	if !m.showFullIDs {
		return shortModel(name)
	}
	return m.fullModelID(name)
}

// fullModelID resolves a name to the id the catalog knows it by, using
// __models__ (m.facts) rather than reassembling an id from parts: the ladder's
// short keys are a naming convention, not a rule, and a guessed id would read
// as authoritative while being wrong. Routing rows already carry full ids, so
// the first arm answers almost always; the scan covers a row that carries a
// ladder key, and an unknown name is returned untouched.
func (m model) fullModelID(name string) string {
	if _, ok := m.facts[name]; ok {
		return name
	}
	var found string
	for id := range m.facts {
		if shortModel(id) == name && (found == "" || id < found) {
			found = id // lowest id wins, so the reveal never flickers between runs
		}
	}
	if found != "" {
		return found
	}
	return name
}

func (m model) paintModel(tok string) string {
	i := strings.LastIndex(tok, ":")
	name, level := tok[:i], tok[i+1:]
	p := providerByModel(name)
	var br, bg, bb float64
	switch {
	case p != nil:
		br, bg, bb = p.PaintRGB[0], p.PaintRGB[1], p.PaintRGB[2]
	case strings.Contains(name, "local-"):
		// Free/local runtimes read green.
		br, bg, bb = 96, 211, 150
	default:
		return m.modelLabel(name) + ":" + level // unknown provider: uncoloured
	}
	f := 0.60 + float64(lvl(level))*0.088
	col := lipgloss.Color(fmt.Sprintf("#%02x%02x%02x", clampByte(br*f), clampByte(bg*f), clampByte(bb*f)))
	return lipgloss.NewStyle().Foreground(col).Render(m.modelLabel(name) + ":" + level)
}

func (m model) colorizeRoute(line string) string {
	return modelRe.ReplaceAllStringFunc(line, m.paintModel)
}

// bucketOf guesses a quota bucket from a model name. It is the fallback for
// catalogs that declare no bucket column, and the only resolver for the bare
// facet name ("spark") the suggest box and the dial list ask about — prefer
// model.bucketFor wherever a receiver is in reach. An unknown name maps to no
// bucket at all rather than someone else's quota window.
func bucketOf(model string) string {
	m := model
	if i := strings.IndexByte(m, ':'); i >= 0 {
		m = m[:i]
	}
	// Provider-scoped ids outside the subscription pools (e.g. slash-scoped
	// local runtimes) have no quota window code knows about. An empty bucket
	// never reads as down, which is exactly right for a free or local model.
	if strings.Contains(m, "/") {
		return ""
	}
	for _, p := range providerRegistry {
		for _, s := range p.Special {
			if strings.Contains(m, s.Bucket) {
				return p.BucketBase + "-" + s.Bucket
			}
		}
	}
	if p := providerByModel(m); p != nil {
		return p.mainBucket()
	}
	for _, p := range providerRegistry {
		for _, pre := range p.ModelPrefixes {
			if strings.Contains(m, pre) {
				return p.mainBucket()
			}
		}
	}
	return ""
}

// bucketFor resolves a routing token's quota bucket from the catalog, falling
// back to the name guess only when the catalog declares none. The catalog wins
// because names are not a taxonomy: claude-mythos-5 sits in omp's catalog at
// the top rung's price yet 404s on this account, and every model omp adds
// would otherwise need one more substring arm here before it could be struck
// through correctly.
func (m model) bucketFor(name string) string {
	id := name
	if i := strings.IndexByte(id, ':'); i >= 0 {
		id = id[:i]
	}
	if f, ok := m.facts[id]; ok {
		if f.bucket != "" {
			return f.bucket
		}
		if p := providerByPool(f.pool); p != nil {
			return p.mainBucket()
		}
	}
	return bucketOf(id)
}
