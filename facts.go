package main

import (
	"bufio"
	"os"
	"strings"
)

// ── data ─────────────────────────────────────────────────────────────────────
// loadBlocks parses a generated page into name -> role rows.
func loadBlocks(path string) map[string][]string {
	blocks := map[string][]string{}
	f, err := os.Open(path)
	if err != nil {
		return blocks
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*128), 1024*128)
	var cur string
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			cur = ""
			continue
		}
		if line[0] != ' ' {
			if fs := strings.Fields(line); len(fs) > 0 {
				cur = fs[0]
				blocks[cur] = nil
			}
			continue
		}
		if cur != "" {
			blocks[cur] = append(blocks[cur], line)
		}
	}
	return blocks
}
