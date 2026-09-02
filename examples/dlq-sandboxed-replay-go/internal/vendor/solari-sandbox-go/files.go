package solari

import (
	"context"
	"encoding/base64"
)

// Files is the filesystem namespace on a Sandbox (fs.* RPCs).
type Files struct {
	sb *Sandbox
}

// Read returns the raw bytes of an in-guest file.
func (f *Files) Read(ctx context.Context, path string) ([]byte, error) {
	raw, err := f.sb.ch.call(ctx, "fs.read", map[string]interface{}{"path": path}, callOptions{})
	if err != nil {
		return nil, err
	}
	var res struct {
		Base64 string `json:"base64"`
	}
	if err := unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(res.Base64)
}

// ReadText is Read decoded as UTF-8 text.
func (f *Files) ReadText(ctx context.Context, path string) (string, error) {
	b, err := f.Read(ctx, path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Write writes bytes to an in-guest path. mode is the unix permission bits (0
// means "unset" — omitted from the wire).
func (f *Files) Write(ctx context.Context, path string, data []byte, mode int) error {
	params := map[string]interface{}{
		"path":   path,
		"base64": base64.StdEncoding.EncodeToString(data),
	}
	if mode != 0 {
		params["mode"] = mode
	}
	_, err := f.sb.ch.call(ctx, "fs.write", params, callOptions{})
	return err
}

// List returns the directory entries at path.
func (f *Files) List(ctx context.Context, path string) ([]FsEntry, error) {
	raw, err := f.sb.ch.call(ctx, "fs.list", map[string]interface{}{"path": path}, callOptions{})
	if err != nil {
		return nil, err
	}
	var res struct {
		Entries []FsEntry `json:"entries"`
	}
	if err := unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.Entries, nil
}

// Stat returns metadata for a single path.
func (f *Files) Stat(ctx context.Context, path string) (*FsStat, error) {
	raw, err := f.sb.ch.call(ctx, "fs.stat", map[string]interface{}{"path": path}, callOptions{})
	if err != nil {
		return nil, err
	}
	var res FsStat
	if err := unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// Mkdir creates a directory (and parents).
func (f *Files) Mkdir(ctx context.Context, path string) error {
	_, err := f.sb.ch.call(ctx, "fs.mkdir", map[string]interface{}{"path": path}, callOptions{})
	return err
}

// Remove deletes a path; recursive removes a directory tree.
func (f *Files) Remove(ctx context.Context, path string, recursive bool) error {
	_, err := f.sb.ch.call(ctx, "fs.remove", map[string]interface{}{
		"path": path, "recursive": recursive,
	}, callOptions{})
	return err
}

// Rename moves/renames a path.
func (f *Files) Rename(ctx context.Context, from, to string) error {
	_, err := f.sb.ch.call(ctx, "fs.rename", map[string]interface{}{"from": from, "to": to}, callOptions{})
	return err
}
