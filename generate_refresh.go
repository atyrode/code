package main

// Fact refresh deliberately does not use loadCatalogBytes: it neither certifies
// reachability nor chooses/validates tier ladders. Curated membership is input.
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type refreshModel struct {
	key, selector string
	node          *yaml.Node
	fields        map[string]*yaml.Node
}

func refreshMapping(node *yaml.Node) map[string]*yaml.Node {
	fields := make(map[string]*yaml.Node, len(node.Content)/2)
	for i := 0; i < len(node.Content); i += 2 {
		fields[node.Content[i].Value] = node.Content[i+1]
	}
	return fields
}

// Validate the whole tree, including custom fields, before mutating any nodes.
// Merge keys, aliases and anchors make field ownership ambiguous; mapping keys
// must be unique strings so neither this writer nor a later YAML decoder guesses.
func validateRefreshYAML(node *yaml.Node) error {
	if node.Anchor != "" || node.Kind == yaml.AliasNode {
		return fmt.Errorf("YAML anchors and aliases are unsupported")
	}
	switch node.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
	case yaml.MappingNode:
		if len(node.Content)%2 != 0 {
			return fmt.Errorf("invalid YAML mapping")
		}
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" || seen[key.Value] {
				return fmt.Errorf("YAML mapping keys must be unique strings (line %d)", key.Line)
			}
			seen[key.Value] = true
		}
	case yaml.ScalarNode:
	default:
		return fmt.Errorf("unsupported YAML node at line %d", node.Line)
	}
	for _, child := range node.Content {
		if err := validateRefreshYAML(child); err != nil {
			return err
		}
	}
	return nil
}

func parseRefreshCatalog(raw []byte) (*yaml.Node, []refreshModel, error) {
	var doc yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&doc); err != nil {
		return nil, nil, err
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, nil, fmt.Errorf("catalog must contain exactly one YAML document")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("catalog must be a mapping")
	}
	if err := validateRefreshYAML(&doc); err != nil {
		return nil, nil, err
	}
	root := refreshMapping(doc.Content[0])
	if date := root["refreshed"]; date != nil && date.Kind != yaml.ScalarNode {
		return nil, nil, fmt.Errorf("refreshed must be a scalar")
	}
	models := root["models"]
	if models == nil || models.Kind != yaml.MappingNode || len(models.Content) == 0 {
		return nil, nil, fmt.Errorf("catalog must contain a nonempty models mapping")
	}
	out := make([]refreshModel, 0, len(models.Content)/2)
	for i := 0; i < len(models.Content); i += 2 {
		key, node := models.Content[i].Value, models.Content[i+1]
		if key == "" || node.Kind != yaml.MappingNode {
			return nil, nil, fmt.Errorf("model %q must be a mapping with a nonempty key", key)
		}
		fields := refreshMapping(node)
		for _, name := range []string{"id", "pool", "cost_in", "cost_out", "context", "thinking", "speed"} {
			if n := fields[name]; n == nil || n.Kind != yaml.ScalarNode {
				return nil, nil, fmt.Errorf("model %q needs scalar %s", key, name)
			}
		}
		if n := fields["ttft"]; n != nil && n.Kind != yaml.ScalarNode {
			return nil, nil, fmt.Errorf("model %q needs scalar ttft", key)
		}
		id, pool := fields["id"], fields["pool"]
		provider := providerByPool(pool.Value)
		if id.Tag != "!!str" || strings.TrimSpace(id.Value) == "" || strings.TrimSpace(id.Value) != id.Value || strings.HasPrefix(id.Value, "-") || pool.Tag != "!!str" || provider == nil {
			return nil, nil, fmt.Errorf("model %q needs a nonempty string id and a registered pool", key)
		}
		out = append(out, refreshModel{key: key, selector: provider.ID + "/" + id.Value, node: node, fields: fields})
	}
	return &doc, out, nil
}

// Identity/envelope failures invalidate the entire metadata collection. Invalid
// individual facts instead become zero values, which can never replace a cache.
func refreshMetadata(raw []byte) (map[string]ompModel, map[string][2]float64, error) {
	var envelope struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Models == nil {
		return nil, nil, fmt.Errorf("metadata must be an object with a models array")
	}
	index := make(map[string]ompModel, len(envelope.Models))
	pricedModels := make([]ompModel, 0, len(envelope.Models))
	for _, rawRow := range envelope.Models {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(rawRow, &row); err != nil || row == nil {
			return nil, nil, fmt.Errorf("metadata model must be an object")
		}
		var m ompModel
		if json.Unmarshal(row["provider"], &m.Provider) != nil || json.Unmarshal(row["id"], &m.ID) != nil || strings.TrimSpace(m.Provider) == "" || strings.TrimSpace(m.ID) == "" {
			return nil, nil, fmt.Errorf("metadata model needs provider and id")
		}
		selector := m.Provider + "/" + m.ID
		if _, exists := index[selector]; exists {
			return nil, nil, fmt.Errorf("duplicate metadata selector %q", selector)
		}
		_ = json.Unmarshal(row["contextWindow"], &m.ContextWindow)
		if err := json.Unmarshal(row["thinking"], &m.Thinking); err != nil {
			m.Thinking = nil
		}
		var cost map[string]json.RawMessage
		if json.Unmarshal(row["cost"], &cost) == nil {
			_ = json.Unmarshal(cost["input"], &m.Cost.Input)
			_ = json.Unmarshal(cost["output"], &m.Cost.Output)
		}
		index[selector] = m
		if positiveRefreshNumber(m.Cost.Input) && positiveRefreshNumber(m.Cost.Output) {
			pricedModels = append(pricedModels, m)
		}
	}
	return index, siblingPrices(pricedModels), nil
}

func positiveRefreshNumber(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func refreshThinking(levels []string) (string, bool) {
	if len(levels) == 0 {
		return "", false
	}
	seen := map[string]bool{}
	for _, level := range levels {
		if _, ok := thIdx(level); !ok || seen[level] {
			return "", false
		}
		seen[level] = true
	}
	return thinkingField(levels), true
}

// A native nonzero exit can still contain successful rows. Only complete chat
// results license an update, and each metric is independently usable. Never use
// a success-only aggregate to disguise failed or missing runs.
func refreshMeasurements(raw []byte, expectedRuns int) (map[string]benchFact, error) {
	report, err := parseBenchReport(raw)
	if err != nil {
		return nil, err
	}
	if report.Profile != "chat" || report.Cache != nil || report.Runs <= 0 || report.Models == nil {
		return nil, fmt.Errorf("benchmark needs a chat profile, positive runs and models array (no cache)")
	}
	if expectedRuns > 0 && report.Runs != expectedRuns {
		return nil, fmt.Errorf("benchmark reported %d runs, requested %d", report.Runs, expectedRuns)
	}
	out := make(map[string]benchFact, len(report.Models))
	for _, model := range report.Models {
		if model.Selector == "" {
			return nil, fmt.Errorf("benchmark row lacks selector")
		}
		if _, exists := out[model.Selector]; exists {
			return nil, fmt.Errorf("duplicate benchmark selector %q", model.Selector)
		}
		out[model.Selector] = benchFact{}
		valid := len(model.Results) == report.Runs
		for _, result := range model.Results {
			valid = valid && result.OK && result.Challenge == "chat"
		}
		if !valid || model.Stats == nil {
			continue
		}
		stats := model.Stats
		speedMetric := stats.GenerationTps
		if speedMetric == nil {
			speedMetric = stats.TokensPerSecond
		}
		speedOK := speedMetric != nil && positiveRefreshNumber(speedMetric.Mean)
		ttftOK := stats.TTFTMs != nil && positiveRefreshNumber(stats.TTFTMs.Mean)
		for _, result := range model.Results {
			speed := result.GenerationTps
			if stats.GenerationTps == nil {
				speed = result.TokensPerSecond
			}
			speedOK = speedOK && positiveRefreshNumber(speed)
			ttftOK = ttftOK && positiveRefreshNumber(result.TTFTMs)
		}
		var fact benchFact
		if speedOK {
			fact.speed = math.Round(speedMetric.Mean*10) / 10
		}
		if ttftOK {
			fact.ttft = math.Round(stats.TTFTMs.Mean/10) / 100
		}
		out[model.Selector] = fact
	}
	return out, nil
}

// Change only the scalar's payload, leaving comments and quoting attached.
func setRefreshScalar(node *yaml.Node, tag, value string) bool {
	if node.Tag == tag && node.Value == value {
		return false
	}
	node.Tag, node.Value = tag, value
	return true
}

func setRefreshFact(model refreshModel, field, tag, value string) bool {
	if node := model.fields[field]; node != nil {
		return setRefreshScalar(node, tag, value)
	}
	// ttft is the only optional fact; keep it beside speed rather than moving
	// any curated/custom fields to accommodate a newly available measurement.
	for i := 0; i < len(model.node.Content); i += 2 {
		if model.node.Content[i].Value == "speed" {
			nodes := []*yaml.Node{{Kind: yaml.ScalarNode, Tag: "!!str", Value: field}, {Kind: yaml.ScalarNode, Tag: tag, Value: value}}
			model.node.Content = append(model.node.Content[:i+2], append(nodes, model.node.Content[i+2:]...)...)
			model.fields[field] = nodes[1]
			return true
		}
	}
	return false
}

func saveRefreshCatalog(path string, original []byte, info os.FileInfo, doc *yaml.Node) error {
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".code-refresh-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := tmp.Write(output.Bytes()); err != nil {
		return err
	}
	if err := tmp.Chmod(info.Mode()); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(info, current) || current.Mode() != info.Mode() || current.Size() != info.Size() || !current.ModTime().Equal(info.ModTime()) {
		return fmt.Errorf("catalog changed during collection; refusing to overwrite it")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	current, err = os.Lstat(path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(info, current) || current.Mode() != info.Mode() || current.Size() != info.Size() || !current.ModTime().Equal(info.ModTime()) {
		return fmt.Errorf("catalog changed during collection; refusing to overwrite it")
	}
	if !bytes.Equal(original, raw) {
		return fmt.Errorf("catalog changed during collection; refusing to overwrite it")
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

func runGenerateRefresh(args []string) int {
	path, benchFile := defaultModelsPath(), ""
	runs, maxTokens := 2, 256
	skipBench := false
	for i := 0; i < len(args); i++ {
		switch flag := args[i]; flag {
		case "-h", "--help":
			fmt.Print(generateHelp)
			return 0
		case "--skip-bench":
			skipBench = true
		case "--models-file", "--bench-json", "--runs", "--max-tokens":
			i++
			if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "--") {
				fmt.Fprintf(os.Stderr, "code generate refresh: %s needs a value\n", flag)
				return 2
			}
			switch flag {
			case "--models-file":
				path = args[i]
			case "--bench-json":
				benchFile = args[i]
			default:
				value, err := strconv.Atoi(args[i])
				if err != nil || value <= 0 {
					fmt.Fprintf(os.Stderr, "code generate refresh: %s must be a positive integer\n", flag)
					return 2
				}
				if flag == "--runs" {
					runs = value
				} else {
					maxTokens = value
				}
			}
		default:
			fmt.Fprintf(os.Stderr, "code generate refresh: unknown flag %q\n%s", flag, generateHelp)
			return 2
		}
	}
	if skipBench && benchFile != "" {
		fmt.Fprintln(os.Stderr, "code generate refresh: --skip-bench and --bench-json are mutually exclusive")
		return 2
	}
	fail := func(status int, err error) int {
		fmt.Fprintf(os.Stderr, "code generate refresh: %v\n", err)
		return status
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fail(1, err)
	}
	if !info.Mode().IsRegular() {
		return fail(2, fmt.Errorf("catalog must be a regular file, not a symlink or device"))
	}
	file, err := os.Open(path)
	if err != nil {
		return fail(1, err)
	}
	opened, statErr := file.Stat()
	if statErr != nil || !os.SameFile(info, opened) {
		file.Close()
		return fail(1, fmt.Errorf("catalog changed while opening it"))
	}
	original, err := io.ReadAll(file)
	file.Close()
	if err != nil {
		return fail(1, err)
	}
	doc, models, err := parseRefreshCatalog(original)
	if err != nil {
		return fail(2, err)
	}
	raw, err := ompModelsJSON()
	if err != nil {
		return fail(1, fmt.Errorf("model metadata unavailable: %w", err))
	}
	metadata, siblings, err := refreshMetadata(raw)
	if err != nil {
		return fail(1, err)
	}
	metadataComplete, changed := true, false
	warn := func(key, field string) {
		fmt.Fprintf(os.Stderr, "code generate refresh: %s: unavailable %s; keeping cached value\n", key, field)
	}
	for _, model := range models {
		row, exists := metadata[model.selector]
		if !exists {
			warn(model.key, "metadata")
			metadataComplete = false
			continue
		}
		prices := [2]float64{row.Cost.Input, row.Cost.Output}
		if !positiveRefreshNumber(prices[0]) || !positiveRefreshNumber(prices[1]) {
			id := strings.ToLower(row.ID)
			if i := strings.LastIndexByte(id, '/'); i >= 0 {
				id = id[i+1:]
			}
			if fallback, ok := siblings[id]; ok {
				prices = fallback
			}
		}
		for i, field := range []string{"cost_in", "cost_out"} {
			if positiveRefreshNumber(prices[i]) {
				changed = setRefreshFact(model, field, "!!float", strconv.FormatFloat(prices[i], 'f', -1, 64)) || changed
			} else {
				warn(model.key, field)
				metadataComplete = false
			}
		}
		if row.ContextWindow > 0 {
			changed = setRefreshFact(model, "context", "!!int", strconv.Itoa(row.ContextWindow)) || changed
		} else {
			warn(model.key, "context")
			metadataComplete = false
		}
		if thinking, ok := refreshThinking(row.Thinking); ok {
			changed = setRefreshFact(model, "thinking", "!!str", thinking) || changed
		} else {
			warn(model.key, "thinking")
			metadataComplete = false
		}
	}
	benchComplete := false
	if !skipBench {
		var benchRaw []byte
		if benchFile != "" {
			benchRaw, err = os.ReadFile(benchFile)
		} else {
			selectors := make([]string, 0, len(models))
			seen := map[string]bool{}
			for _, model := range models {
				if !seen[model.selector] {
					selectors = append(selectors, model.selector)
					seen[model.selector] = true
				}
			}
			benchRaw, err = collectBenchJSON(selectors, runs, maxTokens)
		}
		benchComplete = err == nil
		if err != nil {
			fmt.Fprintf(os.Stderr, "code generate refresh: benchmark collection failed: %v\n", err)
		}
		expectedRuns := runs
		if benchFile != "" {
			expectedRuns = 0
		}
		measurements, parseErr := refreshMeasurements(benchRaw, expectedRuns)
		if parseErr != nil {
			fmt.Fprintf(os.Stderr, "code generate refresh: %v\n", parseErr)
			benchComplete = false
		}
		for _, model := range models {
			fact := measurements[model.selector]
			for i, field := range []string{"speed", "ttft"} {
				value := [2]float64{fact.speed, fact.ttft}[i]
				if positiveRefreshNumber(value) {
					changed = setRefreshFact(model, field, "!!float", strconv.FormatFloat(value, 'f', -1, 64)) || changed
				} else {
					warn(model.key, field)
					benchComplete = false
				}
			}
		}
	}
	complete := metadataComplete && benchComplete
	if complete {
		root := doc.Content[0]
		today := time.Now().UTC().Format("2006-01-02")
		if date := refreshMapping(root)["refreshed"]; date != nil {
			changed = setRefreshScalar(date, "!!str", today) || changed
		} else {
			root.Content = append([]*yaml.Node{{Kind: yaml.ScalarNode, Tag: "!!str", Value: "refreshed"}, {Kind: yaml.ScalarNode, Tag: "!!str", Value: today}}, root.Content...)
			changed = true
		}
	}
	if changed {
		if err := saveRefreshCatalog(path, original, info, doc); err != nil {
			return fail(1, err)
		}
	}
	if complete {
		fmt.Printf("refreshed all model facts in %s\n", path)
	} else {
		reason := "incomplete facts"
		if skipBench {
			reason = "benchmarks skipped"
		}
		fmt.Printf("updated available facts in %s; %s; full-refresh date unchanged\n", path, reason)
	}
	if complete || (skipBench && metadataComplete) {
		return 0
	}
	return 1
}
