package wirejson

import (
	"bytes"
	"encoding/json"
 "errors"
	"io"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"
)

var errInvalid = errors.New("invalid JSON document")

// Struct JSON tags are the allowlist and required-field schema: omitempty is
// optional, and nullable explicitly permits null. Unknown output fields are
// discarded, while unknown caller fields are rejected. Exact names avoid
// encoding/json's case-insensitive matching widening the public boundary.
func Decode(data []byte, destination any, strict bool) error {
	if !utf8.Valid(data) {
		return errInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if checkTokens(decoder, 0) != nil {
		return errInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errInvalid
	}
	value, err := decodeShape(data, reflect.TypeOf(destination).Elem(), strict, false)
	if err != nil {
		return errInvalid
	}
	reflect.ValueOf(destination).Elem().Set(value)
	return nil
}

// Reject duplicate keys rather than allowing last-wins ambiguity. Apply the
// depth bound even to private fields that will be discarded from the result.
func checkTokens(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return errInvalid
	}
	token, err := decoder.Token()
	if err != nil {
		return errInvalid
	}
	if text, ok := token.(string); ok && strings.ContainsRune(text, 0) {
		return errInvalid
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]bool)
		for decoder.More() {
			key, err := decoder.Token()
			name, ok := key.(string)
			if err != nil || !ok || seen[name] || strings.ContainsRune(name, 0) {
				return errInvalid
			}
			seen[name] = true
			if checkTokens(decoder, depth+1) != nil {
				return errInvalid
			}
		}
	case '[':
		for decoder.More() {
			if checkTokens(decoder, depth+1) != nil {
				return errInvalid
			}
		}
	default:
		return errInvalid
	}
	closing, err := decoder.Token()
	if err != nil || (delimiter == '{' && closing != json.Delim('}')) || (delimiter == '[' && closing != json.Delim(']')) {
		return errInvalid
	}
	return nil
}

func decodeShape(data []byte, typ reflect.Type, strict, nullable bool) (reflect.Value, error) {
	data = bytes.TrimSpace(data)
 if typ == reflect.TypeOf(json.RawMessage{}) { return reflect.ValueOf(json.RawMessage(bytes.Clone(data))), nil }
	if bytes.Equal(data, []byte("null")) {
		if nullable {
			return reflect.Zero(typ), nil
		}
		return reflect.Value{}, errInvalid
	}
	if typ == reflect.TypeOf(time.Time{}) {
		var timestamp time.Time
		if json.Unmarshal(data, &timestamp) != nil || timestamp.IsZero() {
			return reflect.Value{}, errInvalid
		}
		return reflect.ValueOf(timestamp), nil
	}
	switch typ.Kind() {
	case reflect.Pointer:
		value, err := decodeShape(data, typ.Elem(), strict, false)
		if err != nil {
			return reflect.Value{}, err
		}
		pointer := reflect.New(typ.Elem())
		pointer.Elem().Set(value)
		return pointer, nil
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return reflect.Value{}, errInvalid
		}
		result := reflect.New(typ).Elem()
		for index := range typ.NumField() {
			field := typ.Field(index)
			name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
			raw, present := fields[name]
			if !present {
				if options == "omitempty" {
					continue
				}
				return reflect.Value{}, errInvalid
			}
			value, err := decodeShape(raw, field.Type, strict, field.Tag.Get("nullable") == "true")
			if err != nil {
				return reflect.Value{}, err
			}
			result.Field(index).Set(value)
			delete(fields, name)
		}
		if strict && len(fields) != 0 {
			return reflect.Value{}, errInvalid
		}
		return result, nil
	case reflect.Slice:
		var rows []json.RawMessage
		if json.Unmarshal(data, &rows) != nil || rows == nil {
			return reflect.Value{}, errInvalid
		}
		result := reflect.MakeSlice(typ, len(rows), len(rows))
		for index, raw := range rows {
			value, err := decodeShape(raw, typ.Elem(), strict, false)
			if err != nil {
				return reflect.Value{}, err
			}
			result.Index(index).Set(value)
		}
		return result, nil
	case reflect.Map:
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return reflect.Value{}, errInvalid
		}
		result := reflect.MakeMapWithSize(typ, len(fields))
		for name, raw := range fields {
			value, err := decodeShape(raw, typ.Elem(), strict, false)
			if err != nil {
				return reflect.Value{}, err
			}
			result.SetMapIndex(reflect.ValueOf(name), value)
		}
		return result, nil
	default:
		result := reflect.New(typ)
		if json.Unmarshal(data, result.Interface()) != nil {
			return reflect.Value{}, errInvalid
		}
		return result.Elem(), nil
	}
}
