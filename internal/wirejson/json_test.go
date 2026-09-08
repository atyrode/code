package wirejson

import (
 "encoding/json"
 "strings"
 "testing"
)

func TestRejectsAmbiguousObjectsRecursively(t *testing.T){
 type request struct{Enabled bool `json:"enabled"`;State map[string]string `json:"state"`}
 for _,raw:=range []string{
  `{"enabled":true,"enabled":false,"state":{}}`,
  `{"Enabled":true,"state":{}}`,
  `{"enabled":null,"state":{}}`,
  `{"enabled":false,"state":{"x":"a","x":"b"}}`,
  `{"enabled":false,"state":{},"credential":"secret"}`,
  `{"enabled":false,"state":{}} {}`,
 }{var out request;if Decode([]byte(raw),&out,true)==nil{t.Errorf("accepted ambiguous input %s",raw)}}
 var out request
 if Decode([]byte(`{"enabled":false,"state":{}}`),&out,true)!=nil||out.Enabled{t.Fatal("valid explicit false rejected")}
}

func TestOpaqueServiceResultStillChecksFraming(t *testing.T){
 var out json.RawMessage
 for _,raw:=range []string{`{"private":{"key":1,"key":2}}`,strings.Repeat("[",66)+"0"+strings.Repeat("]",66),`{"a":"\u0000"}`}{
  if Decode([]byte(raw),&out,true)==nil{t.Fatal("opaque result bypassed token validation")}
 }
 if Decode([]byte(`{"safe":null}`),&out,true)!=nil{t.Fatal("opaque JSON result rejected")}
}
