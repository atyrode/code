package domain

import (
 "github.com/atyrode/code/internal/wirejson"
 "maps"
 "strings"
 "time"
)

type SuggestAction struct {Key string `json:"key"`;Value string `json:"value"`}
type SuggestResult struct {
 SchemaVersion int `json:"schemaVersion"`
 ObservedAt int64 `json:"observedAt"`
 BaseRevision int64 `json:"baseRevision"`
 CatalogRevision string `json:"catalogRevision"`
 Evaluator string `json:"evaluator"`
 Selection map[string]string `json:"selection"`
 Actions []SuggestAction `json:"actions"`
}
const evalSystemPrompt = "You size a coding task by rating its difficulty, then give the matching agent settings. You never do, answer, or research the task itself. Reply in exactly two lines, nothing else."

func nativeSuggest(p SuggestInput,service Services,now time.Time)(any,error){
 state,err:=nativeState(p.State,p.BaseRevision);if err!=nil{return nil,err}
 accounts,err:=loadNativeAccounts(service,now);if err!=nil{return nil,err}
 selected,err:=selectedAccounts(accounts,state);if err!=nil{return nil,err}
 input:=CatalogInput{p.ModelsYAML,p.CatalogRevision,p.Selection,p.State,p.BaseRevision}
 m,err:=newModel(input,selected,now);if err!=nil{return nil,err}
 usage,err:=serviceCall(service,"broker","usage",map[string]any{});if err!=nil{return nil,err}
 a:=parseAvailability(accounts,true,usage,now.Unix());if !a.ok{return nil,errInvalid}
 m.avail=selectedAvailability(a,state.CurrentDisabled())
 raw,err:=serviceCall(service,"suggest","classify",map[string]any{"system":evalSystemPrompt,"prompt":classifyMessage(p.Prompt)});if err!=nil{return nil,err}
 var response struct{
  Message struct{Role string `json:"role"`;Content string `json:"content"`} `json:"message"`
  Done bool `json:"done"`
  Model string `json:"model,omitempty"`
 }
 if wirejson.Decode(raw,&response,true)!=nil||!response.Done||response.Message.Role!="assistant"||len(response.Message.Content)>64<<10{return nil,errInvalid}
 lines:=strings.Split(strings.TrimSpace(response.Message.Content),"\n")
 if len(lines)!=2{return nil,errInvalid}
 var updates map[string]string
 if wirejson.Decode([]byte(lines[1]),&updates,true)!=nil||len(updates)==0{return nil,errInvalid}
 m.sel=maps.Clone(m.sel)
 for key,value:=range updates{m.sel[key]=value}
 if m.validateSelection()!=nil||!m.laneUsable(m.sel["lane"]){return nil,errInvalid}
 m.deriveToggles()
 for key,value:=range updates{m.sel[key]=value}
 if _,explicit:=updates["fast"];!explicit&&len(laneServiceTiers(m.sel["lane"]))==0{m.sel["fast"]="off"}
 if !laneHostsSpecial(m.sel["lane"],"spark"){m.sel["spark"]="off"}
 if owner:=providerBySpecial("spark");owner!=nil{special:=owner.special("spark");if m.avail.down(owner.BucketBase+"-"+special.Bucket){m.sel["spark"]="off"}}
 for key,value:=range updates{if m.sel[key]!=value{return nil,errInvalid}}
 if m.validateSelection()!=nil||!m.laneUsable(m.sel["lane"]){return nil,errInvalid}
 out:=SuggestResult{SchemaVersion:1,ObservedAt:now.Unix(),BaseRevision:p.BaseRevision,CatalogRevision:p.CatalogRevision,Evaluator:response.Model,Selection:m.sel,Actions:[]SuggestAction{}}
 for _,f:=range m.facets{if m.sel[f.key]!=p.Selection[f.key]{out.Actions=append(out.Actions,SuggestAction{f.key,m.sel[f.key]})}}
 return out,nil
}
