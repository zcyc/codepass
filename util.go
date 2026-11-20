package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type uiMode string

const (
	uiInteractive uiMode = "interactive"
	uiAuto        uiMode = "auto"
)

func envString(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && value != "" {
		return value
	}
	return fallback
}

func parseBool(name, value string) (bool, error) {
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false: %s", name, value)
	}
}

func parsePositiveInt(name, value string) (int, error) {
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s must be a positive integer: %s", name, value)
	}
	return n, nil
}

func parseRetryCount(value string) (int, error) {
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 || n > 2 {
		return 0, fmt.Errorf("STRIX_NETWORK_RETRIES must be between 0 and 2: %s", value)
	}
	return n, nil
}

func parseDuration(name, raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, fmt.Errorf("%s must not be empty", name)
	}
	if seconds, err := strconv.ParseFloat(raw, 64); err == nil {
		if seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
			return 0, fmt.Errorf("%s must be positive: %s", name, raw)
		}
		return time.Duration(seconds * float64(time.Second)), nil
	}

	var total float64
	matched := false
	for len(raw) > 0 {
		index := 0
		for index < len(raw) && (raw[index] == '.' || raw[index] >= '0' && raw[index] <= '9') {
			index++
		}
		if index == 0 || index == len(raw) {
			return 0, fmt.Errorf("invalid %s: %s", name, raw)
		}
		number, err := strconv.ParseFloat(raw[:index], 64)
		if err != nil {
			return 0, fmt.Errorf("invalid %s: %s", name, raw)
		}
		unit := raw[index]
		multiplier := map[byte]float64{'h': 3600, 'm': 60, 's': 1}[unit]
		if multiplier == 0 {
			return 0, fmt.Errorf("invalid %s unit: %s", name, string(unit))
		}
		total += number * multiplier
		matched = true
		raw = raw[index+1:]
	}
	if !matched || total <= 0 || math.IsInf(total, 0) {
		return 0, fmt.Errorf("%s must be positive: %s", name, raw)
	}
	return time.Duration(total * float64(time.Second)), nil
}

func budgetPerAttempt(total string, attempts int) (string, error) {
	value, err := strconv.ParseFloat(strings.TrimSpace(total), 64)
	if err != nil || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) || attempts < 1 {
		return "", fmt.Errorf("budget must be a finite positive number")
	}
	result := strconv.FormatFloat(value/float64(attempts), 'f', 12, 64)
	result = strings.TrimRight(strings.TrimRight(result, "0"), ".")
	if result == "" {
		result = "0"
	}
	return result, nil
}

func canonicalPath(raw string) (string, error) {
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}

	var missing []string
	current := abs
	for {
		if _, err := os.Lstat(current); err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("cannot resolve path: %s", raw)
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func pathWithin(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func requireOutside(base, candidate, variable string) error {
	if pathWithin(base, candidate) {
		return fmt.Errorf("%s must be outside the project directory: %s", variable, candidate)
	}
	return nil
}

func homeDir() (string, error) {
	if home := os.Getenv("HOME"); home != "" {
		return canonicalPath(home)
	}
	return os.UserHomeDir()
}

func sanitizeName(value string, limit int) string {
	var b strings.Builder
	for _, r := range value {
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		result = "project"
	}
	if len(result) > limit {
		result = result[:limit]
	}
	return result
}

func validateRunID(value string) error {
	if value == "" || len(value) > 48 {
		return fmt.Errorf("invalid STRIX_RUN_ID: %s", value)
	}
	for _, r := range value {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r)) {
			return fmt.Errorf("invalid STRIX_RUN_ID: %s", value)
		}
	}
	return nil
}

func resolveExecutable(value, fallback string) (string, error) {
	if value == "" {
		value = fallback
	}
	if !strings.ContainsRune(value, os.PathSeparator) {
		path, err := exec.LookPath(value)
		if err != nil {
			return "", err
		}
		return canonicalPath(path)
	}
	path, err := canonicalPath(value)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() || info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("executable is not runnable: %s", path)
	}
	return path, nil
}

func commandOutput(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return "", fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, message)
		}
		return "", fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return string(out), nil
}

func commandExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code := exitErr.ProcessState.ExitCode(); code >= 0 {
			return code
		}
	}
	return 1
}

type lockedWriter struct {
	mu      sync.Mutex
	writers []io.Writer
}

func (w *lockedWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, writer := range w.writers {
		if _, err := writer.Write(data); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

type commandOptions struct {
	dir     string
	env     []string
	mode    uiMode
	timeout time.Duration
	stdin   io.Reader
	stdout  io.Writer
	stderr  io.Writer
}

func runCommand(ctx context.Context, name string, args []string, options commandOptions) (int, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = options.dir
	cmd.Env = options.env
	cmd.Stdin = options.stdin
	cmd.Stdout = options.stdout
	cmd.Stderr = options.stderr
	configureProcess(cmd, options.mode != uiInteractive)
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("start %s: %w", name, err)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var timer <-chan time.Time
	var timeoutTimer *time.Timer
	if options.timeout > 0 {
		timeoutTimer = time.NewTimer(options.timeout)
		timer = timeoutTimer.C
		defer timeoutTimer.Stop()
	}

	select {
	case err := <-done:
		return commandExitCode(err), nil
	case <-ctx.Done():
		terminateProcess(cmd, options.mode != uiInteractive, done)
		return 130, ctx.Err()
	case <-timer:
		terminateProcess(cmd, options.mode != uiInteractive, done)
		return 124, context.DeadlineExceeded
	}
}

func terminateProcess(cmd *exec.Cmd, processGroup bool, done <-chan error) {
	if cmd.Process == nil {
		return
	}
	_ = interruptProcess(cmd, processGroup)
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
		_ = killProcess(cmd, processGroup)
		<-done
	}
}

func fileContains(path, needle string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), needle) {
			return true
		}
	}
	return false
}

func fileContainsAny(path string, needles []string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		for _, needle := range needles {
			if strings.Contains(line, needle) {
				return true
			}
		}
	}
	return false
}

func allFilesNamed(roots []string, name string) []string {
	var paths []string
	seen := make(map[string]bool)
	for _, root := range roots {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil {
				return nil
			}
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Name() != name {
				return nil
			}
			absolute, resolveErr := filepath.Abs(path)
			if resolveErr == nil && !seen[absolute] {
				seen[absolute] = true
				paths = append(paths, absolute)
			}
			return nil
		})
	}
	sort.Strings(paths)
	return paths
}

func sha256Text(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func parseSARIF(path string) (sarifDocument, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return sarifDocument{}, err
	}
	return decodeSARIF(data)
}

func decodeSARIF(data []byte) (sarifDocument, error) {
	var document sarifDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return sarifDocument{}, fmt.Errorf("invalid SARIF JSON: %w", err)
	}
	if document.Runs == nil {
		return sarifDocument{}, errors.New("invalid SARIF: missing runs")
	}
	return document, nil
}

type sarifDocument struct {
	Runs []sarifRun `json:"runs"`
}

type sarifRun struct {
	VersionControlProvenance []struct {
		RevisionID string `json:"revisionId"`
	} `json:"versionControlProvenance"`
	Results []sarifResult `json:"results"`
}

type sarifResult struct {
	RuleID              any             `json:"ruleId"`
	Level               any             `json:"level"`
	Locations           []sarifLocation `json:"locations"`
	Message             sarifMessage    `json:"message"`
	PartialFingerprints map[string]any  `json:"partialFingerprints"`
}

type sarifLocation struct {
	PhysicalLocation sarifPhysicalLocation `json:"physicalLocation"`
}

type sarifPhysicalLocation struct {
	ArtifactLocation sarifArtifactLocation `json:"artifactLocation"`
	Region           sarifRegion           `json:"region"`
}

type sarifArtifactLocation struct {
	URI any `json:"uri"`
}

type sarifRegion struct {
	StartLine   any `json:"startLine"`
	StartColumn any `json:"startColumn"`
	EndLine     any `json:"endLine"`
}

type sarifMessage struct {
	Text any `json:"text"`
}

func sarifText(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.Join(strings.Fields(text), " ")
}

func sarifValue(value any) any {
	if value == nil {
		return 0
	}
	return value
}

func (document sarifDocument) findings() ([]string, int, int) {
	set := make(map[string]bool)
	total, coverage := 0, 0
	for _, run := range document.Runs {
		for _, result := range run.Results {
			total++
			ruleID := sarifText(result.RuleID)
			if strings.HasPrefix(ruleID, "strix-coverage/") {
				coverage++
				continue
			}

			var identity string
			if len(result.PartialFingerprints) > 0 {
				data, _ := json.Marshal(result.PartialFingerprints)
				identity = "partial:" + string(data)
			} else {
				type location struct {
					URI         string `json:"uri"`
					StartLine   any    `json:"startLine"`
					StartColumn any    `json:"startColumn"`
					EndLine     any    `json:"endLine"`
				}
				locations := make([]location, 0, len(result.Locations))
				for _, item := range result.Locations {
					locations = append(locations, location{
						URI:         sarifText(item.PhysicalLocation.ArtifactLocation.URI),
						StartLine:   sarifValue(item.PhysicalLocation.Region.StartLine),
						StartColumn: sarifValue(item.PhysicalLocation.Region.StartColumn),
						EndLine:     sarifValue(item.PhysicalLocation.Region.EndLine),
					})
				}
				sort.Slice(locations, func(i, j int) bool {
					left, _ := json.Marshal(locations[i])
					right, _ := json.Marshal(locations[j])
					return string(left) < string(right)
				})
				message := ""
				if len(locations) == 0 {
					message = sarifText(result.Message.Text)
				}
				payload := struct {
					Rule      string     `json:"rule"`
					Level     string     `json:"level"`
					Locations []location `json:"locations"`
					Message   string     `json:"message"`
				}{ruleID, sarifText(result.Level), locations, message}
				data, _ := json.Marshal(payload)
				identity = string(data)
			}
			set[sha256Text(identity)] = true
		}
	}
	ordered := make([]string, 0, len(set))
	for fingerprint := range set {
		ordered = append(ordered, fingerprint)
	}
	sort.Strings(ordered)
	return ordered, total, coverage
}

func writeFingerprints(path string, fingerprints []string) (string, error) {
	content := strings.Join(fingerprints, "\n")
	if len(fingerprints) > 0 {
		content += "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", err
	}
	return sha256Text(strings.Join(fingerprints, "\n")), nil
}

func runGit(dir string, args ...string) (string, error) {
	return commandOutputWithDir(dir, nil, "git", args...)
}

func commandOutputWithDir(dir string, env []string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return "", fmt.Errorf("%s: %w: %s", name, err, message)
		}
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return string(out), nil
}

func gitStatus(dir string) string {
	output, err := runGit(dir, "status", "--short", "--untracked-files=all")
	if err != nil {
		return ""
	}
	return output
}

func indexTree(dir, indexPath string) (string, error) {
	objectDir := indexPath + ".objects"
	if err := os.MkdirAll(objectDir, 0o700); err != nil {
		return "", err
	}
	gitObjectDir, err := runGit(dir, "rev-parse", "--git-path", "objects")
	if err != nil {
		return "", err
	}
	gitObjectDir = strings.TrimSpace(gitObjectDir)
	if !filepath.IsAbs(gitObjectDir) {
		gitObjectDir = filepath.Join(dir, gitObjectDir)
	}
	env := replaceEnv(os.Environ(), map[string]string{
		"GIT_ALTERNATE_OBJECT_DIRECTORIES": gitObjectDir,
		"GIT_INDEX_FILE":                   indexPath,
		"GIT_OBJECT_DIRECTORY":             objectDir,
	})
	if _, err := runGitWithEnv(dir, env, "rev-parse", "--verify", "HEAD"); err == nil {
		if _, err := commandOutputWithDir(dir, env, "git", "read-tree", "HEAD"); err != nil {
			return "", err
		}
	} else if _, err := commandOutputWithDir(dir, env, "git", "read-tree", "--empty"); err != nil {
		return "", err
	}
	if _, err := commandOutputWithDir(dir, env, "git", "add", "-A", "--", "."); err != nil {
		return "", err
	}
	return runGitWithEnv(dir, env, "write-tree")
}

func runGitWithEnv(dir string, env []string, args ...string) (string, error) {
	return commandOutputWithDir(dir, env, "git", args...)
}

func replaceEnv(base []string, overrides map[string]string) []string {
	result := append([]string(nil), base...)
	seen := make(map[string]bool)
	for index, item := range result {
		key, _, ok := strings.Cut(item, "=")
		if value, exists := overrides[key]; ok && exists {
			result[index] = key + "=" + value
			seen[key] = true
		}
	}
	for key, value := range overrides {
		if !seen[key] {
			result = append(result, key+"="+value)
		}
	}
	return result
}

func writeMetadata(path string, fields map[string]string) error {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&b, "%s=%s\n", key, fields[key])
	}
	return os.WriteFile(path, []byte(b.String()), 0o600)
}

func firstLineValue(path, prefix string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), prefix) {
			return strings.TrimSpace(strings.TrimPrefix(scanner.Text(), prefix))
		}
	}
	return ""
}

func readJSONMap(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func trimOutput(value string) string { return strings.TrimSpace(strings.TrimSuffix(value, "\n")) }

var semverPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

func parseVersion(value string) ([3]int, error) {
	match := semverPattern.FindStringSubmatch(value)
	if len(match) != 4 {
		return [3]int{}, fmt.Errorf("cannot determine version from: %s", value)
	}
	var result [3]int
	for index := 0; index < 3; index++ {
		parsed, err := strconv.Atoi(match[index+1])
		if err != nil {
			return [3]int{}, err
		}
		result[index] = parsed
	}
	return result, nil
}

func versionAtLeast(actual, minimum [3]int) bool {
	for index := range actual {
		if actual[index] != minimum[index] {
			return actual[index] > minimum[index]
		}
	}
	return true
}

func copyFile(src, dst string, mode os.FileMode) error {
	input, err := os.Open(src)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func copyTree(source, target string) error {
	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		destination := filepath.Join(target, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, destination)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(destination, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copyFile(path, destination, info.Mode())
	})
}
