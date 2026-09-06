package main

// Credential redaction over the child's output.
//
// The provider credential reaches OMP through its environment and nowhere
// else, and OMP is not expected to print it. "Not expected" is not a
// guarantee: a diagnostic that dumps the environment, a provider error page
// echoed into an event, a model that reads the variable back — any of them
// would put the token on a stream the client records durably. So every byte
// the engine forwards from the child, stdout and stderr alike, passes through
// this file first, and the token is replaced wherever it appears, in its raw
// form and in the form JSON gives it when it needs escaping.
//
// The stream is otherwise untouched. A line that carries no secret is
// forwarded byte for byte, which is what lets the client speak OMP's protocol
// natively through this process: nothing here decodes a frame in order to
// re-encode it, and a frame this build has never seen is a frame it forwards.
//
// One framing detail has to be understood rather than passed through. OMP's
// RPC protocol version 2 carries a stdout object above 1 MiB as a run of
// rpc_chunk lines, each holding a base64 segment of the object's UTF-8 bytes.
// A token inside such an object is invisible to a substring search over the
// line — it is base64, and it may straddle two segments — so a chunked object
// is reassembled, redacted, and re-chunked exactly as OMP's own encoder would
// have chunked the redacted text. The rules that decoder enforces are the ones
// applied here: segments of 256 KiB, a declared byte length between 1 MiB and
// 64 MiB, at least two chunks, and a consecutive run with nothing in between.
// A redacted object that shrank below the chunking threshold goes out as one
// ordinary line, which is what the encoder emits for an object that size.

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
)

// engineRedacted replaces a secret anywhere it would otherwise be written.
var engineRedacted = []byte("[redacted]")

// OMP's chunk framing limits, from its RPC frame encoder (v18.1.11): a
// physical line is capped at 1 MiB, a chunked object at 64 MiB, and each
// chunk carries 256 KiB of the object.
const (
	ompChunkFrameBytes       = 1 << 20
	ompChunkReassembledBytes = 64 << 20
	ompChunkSegmentBytes     = 256 << 10
)

// secretRedactor holds the byte sequences to replace. There are at most two
// per secret: the bytes as given, and the bytes as JSON escapes them when the
// two differ.
type secretRedactor struct {
	needles [][]byte
}

func newSecretRedactor(secrets []string) *secretRedactor {
	r := &secretRedactor{}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		r.needles = append(r.needles, []byte(secret))
		if encoded, err := json.Marshal(secret); err == nil && len(encoded) > 2 {
			if inner := encoded[1 : len(encoded)-1]; !bytes.Equal(inner, []byte(secret)) {
				r.needles = append(r.needles, inner)
			}
		}
	}
	return r
}

func (r *secretRedactor) active() bool { return r != nil && len(r.needles) > 0 }

// redact replaces every needle in b. It returns b itself when nothing matched,
// so the common line costs a search and no copy.
func (r *secretRedactor) redact(b []byte) []byte {
	for _, needle := range r.needles {
		if bytes.Contains(b, needle) {
			b = bytes.ReplaceAll(b, needle, engineRedacted)
		}
	}
	return b
}

// longest is the length of the longest needle, which is how much of a stream
// has to be held back between two reads so a secret split across them is still
// seen whole.
func (r *secretRedactor) longest() int {
	n := 0
	for _, needle := range r.needles {
		if len(needle) > n {
			n = len(needle)
		}
	}
	return n
}

// Write redacts one write and passes it on. It is the shape stderr needs — the
// child's diagnostics arrive as writes from exec's own copying goroutine — and
// it is only correct for a stream where a secret is never split across two
// writes, which stderr's line-at-a-time diagnostics satisfy well enough for
// the defence this is: stdout, where the bytes are the client's record, goes
// through forward instead.
type redactingWriter struct {
	redactor *secretRedactor
	dst      io.Writer
}

func (w redactingWriter) Write(p []byte) (int, error) {
	if _, err := w.dst.Write(w.redactor.redact(p)); err != nil {
		return 0, err
	}
	return len(p), nil
}

// ompChunkFrame is one rpc_chunk line as OMP encodes it, field order included:
// a re-chunked object has to be a line OMP's own decoder accepts, and the
// order is the one its encoder writes.
type ompChunkFrame struct {
	Type       string `json:"type"`
	ChunkID    string `json:"chunkId"`
	Index      int    `json:"index"`
	Count      int    `json:"count"`
	ByteLength int    `json:"byteLength"`
	Data       string `json:"data"`
}

// ompChunkPrefix is how every chunk line OMP writes begins. The encoder puts
// type first, so a line that does not start this way is not a chunk and is
// never parsed — which keeps the cost of forwarding an ordinary frame at one
// prefix comparison.
var ompChunkPrefix = []byte(`{"type":"rpc_chunk"`)

// forward copies src to dst with every secret redacted, line by line, and
// reassembles chunked objects on the way. It returns when src ends.
//
// A line longer than ompFrameBytes is forwarded in pieces, each redacted with
// the tail of the previous one held back so a secret straddling two pieces is
// still seen. OMP never writes such a line — its physical frame cap is half
// that — so this is the path a misbehaving child takes, and it degrades to
// forwarding rather than to refusing the stream.
func (r *secretRedactor) forward(dst io.Writer, src io.Reader) error {
	if !r.active() {
		_, err := io.Copy(dst, src)
		return err
	}
	in := bufio.NewReaderSize(src, ompFrameBytes)
	var pending []ompChunkFrame
	pendingBytes := 0
	carry := r.longest() - 1
	for {
		line, err := in.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			// The line does not fit the reader; stream it out in pieces.
			if len(pending) > 0 {
				return errors.New("the child interrupted a chunked frame with an oversized line")
			}
			eof, err := r.forwardOversized(dst, in, line, carry)
			if err != nil {
				return err
			}
			if eof {
				return nil
			}
			continue
		}
		if len(line) > 0 {
			var out []byte
			var chunkErr error
			out, pending, pendingBytes, chunkErr = r.forwardLine(line, pending, pendingBytes)
			if chunkErr != nil {
				return chunkErr
			}
			if len(out) > 0 {
				if _, err := dst.Write(out); err != nil {
					return err
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if len(pending) > 0 {
					return errors.New("the child ended its output inside a chunked frame, which was dropped unforwarded")
				}
				return nil
			}
			return err
		}
	}
}

// forwardLine handles one complete line: a chunk is collected and, when its
// run is complete, the object is redacted and re-chunked; anything else is
// redacted and returned as is.
func (r *secretRedactor) forwardLine(line []byte, pending []ompChunkFrame, pendingBytes int,
) (out []byte, still []ompChunkFrame, stillBytes int, err error) {
	if !bytes.HasPrefix(line, ompChunkPrefix) {
		if len(pending) > 0 {
			// OMP's decoder refuses an interrupted chunk run, and so does
			// this: the held chunks cannot be forwarded unredacted, and a
			// stream that interleaves is not one this build understands.
			return nil, nil, 0, errors.New("the child interrupted a chunked frame with another line")
		}
		return r.redact(line), nil, 0, nil
	}
	var chunk ompChunkFrame
	if json.Unmarshal(bytes.TrimSpace(line), &chunk) != nil || chunk.Type != "rpc_chunk" {
		if len(pending) > 0 {
			return nil, nil, 0, errors.New("the child interrupted a chunked frame with an unreadable line")
		}
		return r.redact(line), nil, 0, nil
	}
	if err := ompChunkValid(chunk, pending); err != nil {
		return nil, nil, 0, err
	}
	pending = append(pending, chunk)
	pendingBytes += len(chunk.Data)
	if pendingBytes > ompChunkReassembledBytes*4/3+4 {
		return nil, nil, 0, errors.New("the child's chunked frame exceeds the transport limit")
	}
	if len(pending) < chunk.Count {
		return nil, pending, pendingBytes, nil
	}
	object, err := ompChunkAssemble(pending)
	if err != nil {
		return nil, nil, 0, err
	}
	return ompChunkEncode(pending[0].ChunkID, r.redact(object)), nil, 0, nil
}

// ompChunkValid applies the decoder's own consistency rules to one chunk
// against the run it belongs to, so a malformed run is refused here the way
// the client would refuse it rather than reassembled into something else.
func ompChunkValid(chunk ompChunkFrame, pending []ompChunkFrame) error {
	if chunk.ChunkID == "" || len(chunk.ChunkID) > 128 || chunk.Count < 2 ||
		chunk.Count > (ompChunkReassembledBytes+ompChunkSegmentBytes-1)/ompChunkSegmentBytes ||
		chunk.Index < 0 || chunk.Index >= chunk.Count ||
		chunk.ByteLength < ompChunkFrameBytes || chunk.ByteLength > ompChunkReassembledBytes {
		return errors.New("the child wrote an rpc_chunk with invalid metadata")
	}
	if len(pending) == 0 {
		if chunk.Index != 0 {
			return errors.New("the child started a chunked frame at a nonzero index")
		}
		return nil
	}
	first := pending[0]
	if chunk.ChunkID != first.ChunkID || chunk.Count != first.Count ||
		chunk.ByteLength != first.ByteLength || chunk.Index != len(pending) {
		return errors.New("the child's chunked frame is out of sequence")
	}
	return nil
}

// ompChunkAssemble decodes a complete run back into the object's bytes and
// checks them against the declared length, as the decoder does.
func ompChunkAssemble(run []ompChunkFrame) ([]byte, error) {
	object := make([]byte, 0, run[0].ByteLength)
	for _, chunk := range run {
		segment, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil || len(segment) > ompChunkSegmentBytes {
			return nil, errors.New("the child wrote an rpc_chunk whose data is not a valid segment")
		}
		object = append(object, segment...)
	}
	if len(object) != run[0].ByteLength {
		return nil, errors.New("the child's chunked frame does not match its declared length")
	}
	return object, nil
}

// ompChunkEncode frames one object as OMP's encoder would: as one line when
// it fits a physical frame, otherwise as a run of chunks.
func ompChunkEncode(chunkID string, object []byte) []byte {
	if len(object) < ompChunkFrameBytes {
		return append(append(make([]byte, 0, len(object)+1), object...), '\n')
	}
	count := (len(object) + ompChunkSegmentBytes - 1) / ompChunkSegmentBytes
	var out bytes.Buffer
	for i := range count {
		end := (i + 1) * ompChunkSegmentBytes
		if end > len(object) {
			end = len(object)
		}
		line, err := json.Marshal(ompChunkFrame{
			Type:       "rpc_chunk",
			ChunkID:    chunkID,
			Index:      i,
			Count:      count,
			ByteLength: len(object),
			Data:       base64.StdEncoding.EncodeToString(object[i*ompChunkSegmentBytes : end]),
		})
		if err != nil {
			// Unreachable: every field is a string or an int.
			panic("code: rpc chunk is not encodable: " + err.Error())
		}
		out.Write(line)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

// forwardOversized streams a line that overflowed the reader, piece by piece,
// holding back carry bytes between pieces so a secret split across two of
// them is still seen whole. It reports whether the source ended inside the
// line.
func (r *secretRedactor) forwardOversized(dst io.Writer, in *bufio.Reader, first []byte, carry int) (eof bool, err error) {
	held := append([]byte(nil), first...)
	for {
		piece, err := in.ReadSlice('\n')
		held = append(held, piece...)
		if err == nil || !errors.Is(err, bufio.ErrBufferFull) {
			if _, werr := dst.Write(r.redact(held)); werr != nil {
				return false, werr
			}
			if errors.Is(err, io.EOF) {
				return true, nil
			}
			return false, err
		}
		// A complete secret may straddle the carry cut, so scrub before
		// splitting rather than exposing its unmatched prefix.
		held = r.redact(held)
		if len(held) > carry {
			if _, werr := dst.Write(held[:len(held)-carry]); werr != nil {
				return false, werr
			}
			held = append(held[:0], held[len(held)-carry:]...)
		}
	}
}

// redactString is the scrubbed form of a diagnostic, for the engine's own
// stderr lines.
func (r *secretRedactor) redactString(s string) string {
	if !r.active() {
		return s
	}
	return string(r.redact([]byte(s)))
}
