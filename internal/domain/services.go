package domain

import (
 "github.com/atyrode/code/internal/wirejson"
 "encoding/json"
 "sort"
 "strconv"
 "strings"
 "time"
)

func serviceCall(service Services,id,op string,input map[string]any)([]byte,error){
 if service==nil{return nil,errInvalid}
 raw,err:=service.Call(id,op,input)
 if err!=nil||len(raw)>128<<10{return nil,errInvalid}
 var document json.RawMessage
 if wirejson.Decode(raw,&document,true)!=nil{return nil,errInvalid}
 return raw,nil
}

// This is a projection of OMP's snapshot, not its credential-bearing wire type.
// The native resolver must project it before it crosses the process boundary.
func loadNativeAccounts(service Services,now time.Time)(map[string][]account,error){
 raw,err:=serviceCall(service,"broker","metadata",map[string]any{});if err!=nil{return emptyAccounts(),err}
 var snapshot struct{Credentials []struct{
  ID int64 `json:"id"`
  Provider string `json:"provider"`
  IdentityKey *string `json:"identityKey" nullable:"true"`
  Credential struct{Type string `json:"type"`;Email string `json:"email,omitempty"`} `json:"credential"`
  Blocks []struct{BlockScope string `json:"blockScope"`;BlockedUntilMs int64 `json:"blockedUntilMs"`} `json:"blocks,omitempty"`
 } `json:"credentials"`}
 if wirejson.Decode(raw,&snapshot,true)!=nil{return emptyAccounts(),errInvalid}
 out:=emptyAccounts();seen:=map[accountKey]bool{};ids:=map[int64]bool{}
 for _,row:=range snapshot.Credentials{
  if row.ID<=0||ids[row.ID]{return emptyAccounts(),errInvalid};ids[row.ID]=true
  p:=providerByID(row.Provider);if p==nil{continue}
  identity:="";if row.IdentityKey!=nil{identity=*row.IdentityKey}
  a:=account{Provider:p.ID,IdentityKey:identity,Email:row.Credential.Email,credentialID:strconv.FormatInt(row.ID,10)}
  switch row.Credential.Type{case "oauth":if strings.TrimSpace(identity)==""{return emptyAccounts(),errInvalid};case "api_key":if p.Metered{continue};default:return emptyAccounts(),errInvalid}
  key:=accountKey{p.ID,identity};if seen[key]{return emptyAccounts(),errInvalid};seen[key]=true
  for _,b:=range row.Blocks{until:=time.UnixMilli(b.BlockedUntilMs);if until.After(now){a.blocks=append(a.blocks,accountBlock{b.BlockScope,until})}}
  sort.Slice(a.blocks,func(i,j int)bool{return a.blocks[i].Until.After(a.blocks[j].Until)})
  out[p.ID]=append(out[p.ID],a)
 }
 for _,p:=range providerRegistry{sort.Slice(out[p.ID],func(i,j int)bool{return out[p.ID][i].IdentityKey<out[p.ID][j].IdentityKey})}
 return out,nil
}
