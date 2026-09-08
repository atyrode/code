package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"slices"
	"strings"
)

const launchHelp = `code launch — start an omp session without mounting the TUI

  code launch [--selection '<facet-map-json>'] [--kind generated|managed|untrusted|runtime]
              [--account-selection '<account-selection-json>']
              [--runtime TARGET] [--worktree] [--prompt TEXT] [-- OMP_ARGS...]

Generated is the default. Selection overlays catalog defaults, never saved UI
choices. Managed and untrusted launches take no facets. Runtime requires an
advertised --runtime target and accepts only the thinking facet. Routing/profile
flags are filtered just as in the TUI. Local engine profiles still require the
interactive confirmation ceremony; this command does not mint profiles.
Account selection is a version-1 object with a disabled reference array. It
overrides only this generated or managed launch; saved account choices are untouched.
`

// decodeLaunchSelection accepts exactly one object of unique string-valued keys.
// In particular null is not an empty selection, and a second JSON value is not
// silently ignored by the streaming decoder.
func decodeLaunchSelection(text string) (map[string]string, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	first, err := dec.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("selection must be a JSON object of facet strings")
	}
	selection := map[string]string{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, errors.New("invalid selection JSON")
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("invalid selection key")
		}
		if _, exists := selection[key]; exists {
			return nil, fmt.Errorf("duplicate selection facet %q", key)
		}
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, errors.New("invalid selection JSON")
		}
		str, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("selection facet %q must be a string", key)
		}
		selection[key] = str
	}
	if _, err := dec.Token(); err != nil {
		return nil, errors.New("invalid selection JSON")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("selection must contain exactly one JSON object")
	}
	return selection, nil
}

func decodeLaunchAccountSelection(raw string) (accountSelectionState, error) {
	state := defaultAccountSelectionState()
	var version int
	var refs json.RawMessage
	if decodeAccountObject(raw, map[string]any{"schemaVersion": &version, "disabled": &refs}) != nil || version != 1 {
		return state, errors.New("invalid launch account selection")
	}
	disabled, err := decodeAccountReferences(string(refs))
	if err != nil {
		return state, err
	}
	state.SetManualDisabled(disabled)
	state.strictLaunch = true
	return state, nil
}

// loadHeadlessModel reads one snapshot of the same capabilities as the TUI. It
// constructs no Bubble Tea widgets, reads no persisted facet selection, and
// discovers no ceremony-only local lane.
func loadHeadlessModel(accountOverride *accountSelectionState) (model, error) {
	catalogPath := os.Getenv("CODE_GENERATED")
	explicit := catalogPath != ""
	if !explicit {
		catalogPath = defaultCatalogPath()
	}
	generated, err := loadBlocksChecked(catalogPath)
	if err != nil && (explicit || !os.IsNotExist(err)) {
		return model{}, errors.New("catalog unavailable or unreadable")
	}
	if err == nil {
		valid := false
		for id, rows := range generated {
			if strings.Contains(id, "_") && !strings.HasPrefix(id, "__") && launchRowsValid(rows) {
				valid = true
				break
			}
		}
		if !valid {
			return model{}, errors.New("catalog contains no runnable combinations")
		}
	}
	glyphs := resolveGlyphs()
	m := model{
		generated:         generated,
		advisors:          parseAdvisors(generated["__advisors__"]),
		facts:             parseFacts(generated["__models__"]),
		glyphs:            glyphs,
		facets:            facetDefs(glyphs),
		sel:               defaultSel(),
		broker:            resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), os.Getenv("CODE_AUTH_VAULTS_FILE")),
		runtimeTargets:    loadRuntimeTargets(),
	}
	if accountOverride != nil {
		if !m.broker.configured() {
			return model{}, errors.New("portable account choices require an available broker")
		}
		m.accountSelections = *accountOverride
	} else {
		m.accountSelections = loadAccountSelectionState(os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
	}
	if len(m.runtimeTargets) > 0 {
		m.facets = append([]facet{runtimeFacet(glyphs["runtime"], m.runtimeTargets)}, m.facets...)
		m.sel["runtime"] = "hosted"
	}
	_, sandboxErr := resolveLaunchPath("CODE_OMP_UNTRUSTED", []string{"ompu"})
	m.hasSandbox = sandboxErr == nil
	m.applyCatalog()
	version := probeOmpVersion()
	m.ompMajor, m.ompMinor = version.major, version.minor
	if m.broker.configured() {
		m.avail = loadAvailability(m.broker)
		if accountOverride != nil && !accountOverride.strictLaunch {
			m.accountSelections = pruneAccountSelectionState(m.accountSelections, m.avail)
			m.applyProviderAvailability(connectedPools(m.selectedLaunchAvailability().accounts))
		} else {
			m.applyProviderAvailability(connectedPools(m.avail.accounts))
		}
	} else {
		m.avail = loadUsageCache(os.Getenv("CODE_USAGE_CACHE"))
		m.applyProviderAvailability(probeProviderAvailability())
	}
	return m, nil
}

func launchRowsValid(rows []string) bool {
	for _, row := range rows {
		fields := strings.Fields(row)
		if len(fields) >= 2 && fields[0] == "default" && modelRe.MatchString(fields[1]) {
			return true
		}
	}
	return false
}

// selectHeadlessModel adjusts only unspecified defaults. Every supplied key is
// checked again after catalog clamping, so neither an unavailable provider nor
// a missing tier can quietly substitute a different requested selection.
func selectHeadlessModel(m model, selection map[string]string) (model, error) {
	m.sel = maps.Clone(m.sel)
	if m.sel == nil {
		m.sel = defaultSel()
	}
	for key, value := range selection {
		known := false
		for _, f := range m.facets {
			if f.key == key {
				known = slices.Contains(f.values, value)
				break
			}
		}
		if !known {
			return model{}, fmt.Errorf("unsupported selection %q=%q", key, value)
		}
		m.sel[key] = value
	}
	if _, runtime := m.selectedRuntime(); runtime {
		return m, nil
	}
	if _, explicit := selection["lane"]; explicit && !m.laneUsable(m.sel["lane"]) {
		return model{}, errors.New("requested provider lane is unavailable")
	}
	repairSelectionSpecials(m.sel)
	m.clampSel()
	for key, value := range selection {
		if m.sel[key] != value {
			return model{}, fmt.Errorf("selection %q=%q is unavailable for this combination", key, value)
		}
	}
	if selection["fast"] == "on" && len(laneServiceTiers(m.sel["lane"])) == 0 {
		return model{}, errors.New("selected lane has no priority service tier")
	}
	if level := selection["advisor"]; level != "" && level != "off" && len(m.advisorChain(level)) == 0 {
		return model{}, errors.New("selected lane has no advisor for the requested level")
	}
	if len(m.generated) > 0 && !launchRowsValid(m.generated[comboID(m.sel)]) {
		return model{}, errors.New("catalog has no profile for this combination")
	}
	if len(m.generated) == 0 && len(selection) > 0 {
		return model{}, errors.New("facet selection requires a catalog")
	}
	return m, nil
}

func runLaunch(args []string) int {
	fs := flag.NewFlagSet("code launch", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() { fmt.Fprint(os.Stderr, launchHelp) }
	selectionJSON := fs.String("selection", "{}", "facet map JSON")
	accountSelectionJSON := fs.String("account-selection", "", "launch account selection JSON")
	kind := fs.String("kind", "generated", "launch kind")
	runtime := fs.String("runtime", "", "runtime target")
	worktree := fs.Bool("worktree", false, "launch in an isolated worktree")
	prompt := fs.String("prompt", "", "first prompt")
	// Only the explicit separator opens omp argv; positional text before it is
	// not accidentally interpreted as a prompt or a Code option.
	options, forwarded := args, []string(nil)
	if separator := slices.Index(args, "--"); separator >= 0 {
		options, forwarded = args[:separator], args[separator+1:]
	}
	if err := fs.Parse(options); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "code launch:", err)
		return 2
	}
	if fs.NArg() != 0 {
		return fail(errors.New("omp arguments must follow --"))
	}
	if !slices.Contains([]string{"generated", "managed", "untrusted", "runtime"}, *kind) {
		return fail(errors.New("unsupported launch kind"))
	}
	selection, err := decodeLaunchSelection(*selectionJSON)
	if err != nil {
		return fail(err)
	}
	if *kind != "runtime" && *runtime != "" {
		return fail(errors.New("--runtime requires --kind runtime"))
	}
	var accountOverride *accountSelectionState
	accountSelectionSupplied := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "account-selection" {
			accountSelectionSupplied = true
		}
	})
	if accountSelectionSupplied {
		if *kind != "generated" && *kind != "managed" {
			return fail(errors.New("--account-selection requires generated or managed launch"))
		}
		state, err := decodeLaunchAccountSelection(*accountSelectionJSON)
		if err != nil {
			return fail(err)
		}
		accountOverride = &state
	}
	var m model
	switch *kind {
	case "generated":
		m, err = loadHeadlessModel(accountOverride)
		if err != nil {
			return fail(err)
		}
		m, err = selectHeadlessModel(m, selection)
		if err != nil {
			return fail(err)
		}
		if target, selected := m.selectedRuntime(); selected {
			return fail(fmt.Errorf("runtime %q requires --kind runtime", target.Name))
		}
		if !launchRowsValid(m.generated[comboID(m.sel)]) {
			return fail(errors.New("generated launch requires a runnable catalog combination"))
		}
		if m.noProviders || !m.laneUsable(m.sel["lane"]) {
			return fail(errors.New("no available provider for the selected lane"))
		}
		m.genConfig = m.genConfigYAML()
	case "managed", "untrusted":
		if len(selection) != 0 {
			return fail(errors.New("managed and untrusted launches do not accept facets"))
		}
		m.launchManaged, m.launchUntrusted = *kind == "managed", *kind == "untrusted"
		if m.launchManaged {
			m.broker = resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), os.Getenv("CODE_AUTH_VAULTS_FILE"))
			if accountOverride != nil {
				m.accountSelections = *accountOverride
			} else {
				m.accountSelections = loadAccountSelectionState(os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
			}
			m.avail = loadUsageCache(os.Getenv("CODE_USAGE_CACHE"))
		}
	case "runtime":
		if *runtime == "" {
			return fail(errors.New("--kind runtime requires --runtime TARGET"))
		}
		m.sel = defaultSel()
		for key, value := range selection {
			if key != "thinking" || !slices.Contains(genThinking, value) {
				return fail(errors.New("runtime selection accepts only a valid thinking facet"))
			}
			m.sel[key] = value
		}
		m.runtimeTargets = loadRuntimeTargets()
		m.sel["runtime"] = *runtime
		if _, found := m.selectedRuntime(); !found {
			return fail(errors.New("runtime target is unavailable"))
		}
		m.launchRuntime = *runtime
	}
	m.firstPrompt, m.worktreeMode = *prompt, *worktree
	if *worktree {
		repo := probeGitRepo()
		if !repo.ok {
			return fail(errors.New("--worktree requires a git repository"))
		}
		m.gitRoot, m.gitPrefix = repo.root, repo.prefix
	}
	return executeLaunch(m, forwarded)
}
