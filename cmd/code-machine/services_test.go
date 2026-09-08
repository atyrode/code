package main

import (
 "bufio"
 "encoding/json"
 "fmt"
 "net"
 "testing"
)

func TestServiceContextBootstrapAndCorrelation(t *testing.T){
 client,server:=net.Pipe();defer client.Close();defer server.Close()
 service:=nativeServices{conn:client,reader:bufio.NewReaderSize(client,maxServiceFrame)}
 done:=make(chan error,1)
 go func(){
  raw,err:=bufio.NewReader(server).ReadBytes('\n');if err!=nil{done<-err;return}
  var request struct{RequestID string `json:"requestId"`};if err=json.Unmarshal(raw,&request);err!=nil{done<-err;return}
  _,err=fmt.Fprintf(server,"{\"type\":\"context\",\"locations\":[]}\n{\"type\":\"service_result\",\"requestId\":%q,\"ok\":true,\"result\":{\"ok\":true}}\n",request.RequestID)
  done<-err
 }()
 raw,err:=service.Call("broker","health",map[string]any{})
 if err!=nil||string(raw)!=`{"ok":true}`{t.Fatalf("bootstrap prevented actual response: %s %v",raw,err)}
 if err:=<-done;err!=nil{t.Fatal(err)}
}

func TestServiceRejectsUncorrelatedAndAmbiguousReplies(t *testing.T){
 for _,reply:=range []string{
  `{"type":"service_result","requestId":"different-job","ok":true,"result":{"secret":"must-not-return"}}`,
  `{"type":"service_result","requestId":"1","ok":true,"ok":false,"result":{"secret":"must-not-return"}}`,
  `{"type":"service_result","requestId":"1","ok":true,"result":{},"refusal":"denied"}`,
 }{
  client,server:=net.Pipe()
  service:=nativeServices{conn:client,reader:bufio.NewReaderSize(client,maxServiceFrame)}
  done:=make(chan struct{})
  go func(){defer close(done);defer server.Close();bufio.NewReader(server).ReadBytes('\n');fmt.Fprintln(server,reply)}()
  raw,err:=service.Call("broker","health",map[string]any{})
  if err==nil||raw!=nil{t.Errorf("untrusted reply returned data: %s %v",raw,err)}
  client.Close();<-done
 }
}
