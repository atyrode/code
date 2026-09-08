package main

import (
 "bufio"
 "encoding/json"
 "errors"
 "net"
 "os"
 "strconv"
 "sync"
 "time"

 "github.com/atyrode/code/internal/wirejson"
)

const maxServiceFrame = 128 << 10
var errInvalid = errors.New("invalid operation data")

type nativeServices struct {
 mu sync.Mutex
 conn net.Conn
 reader *bufio.Reader
 next uint64
 failed bool
 contextSeen bool
}

func(s *nativeServices)close(){if s.conn!=nil{s.conn.Close()}}

func(s *nativeServices)Call(service,operation string,input map[string]any)([]byte,error){
 s.mu.Lock();defer s.mu.Unlock()
 if s.failed{return nil,errInvalid}
 // A broken/ambiguous channel must not be reused for a later privileged call.
 s.failed=true
 if s.conn==nil {
  fd,err:=strconv.Atoi(os.Getenv("MANIFOLD_JOB_CONTEXT_FD"));if err!=nil||fd<3{return nil,errInvalid}
  file:=os.NewFile(uintptr(fd),"native-job-context");if file==nil{return nil,errInvalid}
  // The owner supplies a Unix stream socketpair. FileConn duplicates the fd
  // and configures Go's network poller, including deadlines on inherited fds.
  conn,err:=net.FileConn(file);file.Close();if err!=nil{return nil,errInvalid}
  s.conn=conn;s.reader=bufio.NewReaderSize(conn,maxServiceFrame)
 }
 if err:=s.conn.SetDeadline(time.Now().Add(60*time.Second));err!=nil{return nil,errInvalid}
 s.next++;requestID:=strconv.FormatUint(s.next,10)
 frame,err:=json.Marshal(struct{
  Type string `json:"type"`;RequestID string `json:"requestId"`;ServiceID string `json:"serviceId"`;OperationID string `json:"operationId"`;Input map[string]any `json:"input"`
 }{"service",requestID,service,operation,input})
 if err!=nil||len(frame)+1>maxServiceFrame{return nil,errInvalid}
 frame=append(frame,'\n')
 if n,err:=s.conn.Write(frame);err!=nil||n!=len(frame){return nil,errInvalid}
 for {
  raw,err:=s.reader.ReadSlice('\n');if err!=nil||len(raw)>maxServiceFrame{return nil,errInvalid}
  var kind struct{Type string `json:"type"`}
  if wirejson.Decode(raw,&kind,false)!=nil{return nil,errInvalid}
  if kind.Type=="context" {
   if s.contextSeen||s.next!=1{return nil,errInvalid}
   var bootstrap struct{
    Type string `json:"type"`
    Locations []struct{LocationID string `json:"locationId"`;GuestPath string `json:"guestPath"`;Access string `json:"access"`} `json:"locations"`
   }
   if wirejson.Decode(raw,&bootstrap,true)!=nil{return nil,errInvalid}
   s.contextSeen=true
   // Locations belong to native execution, not a second Code path registry.
   continue
  }
  var envelope struct{
   Type string `json:"type"`;RequestID string `json:"requestId"`;OK bool `json:"ok"`
   Result json.RawMessage `json:"result,omitempty"`;Refusal string `json:"refusal,omitempty"`
  }
  if wirejson.Decode(raw,&envelope,true)!=nil||envelope.Type!="service_result"||envelope.RequestID!=requestID{return nil,errInvalid}
  if !envelope.OK {if envelope.Refusal==""||envelope.Result!=nil{return nil,errInvalid};s.failed=false;return nil,errInvalid}
  if envelope.Result==nil||envelope.Refusal!=""{return nil,errInvalid}
  s.failed=false
  return envelope.Result,nil
 }
}
