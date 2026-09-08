package domain

import (
 "encoding/json"
 "errors"
 "strings"
 "testing"
 "time"
)

type fixtureServices map[string]string
func(s fixtureServices)Call(service,operation string,_ map[string]any)([]byte,error){
 value,ok:=s[service+"/"+operation];if !ok{return nil,errors.New("unavailable")};return []byte(value),nil
}
const nativeMetadata = `{"credentials":[{"id":1,"provider":"openai-codex","identityKey":"codex","credential":{"type":"oauth","email":"codex@example.test"}},{"id":2,"provider":"anthropic","identityKey":"claude","credential":{"type":"oauth","email":"claude@example.test"}}]}`
func nativeCatalogInput()CatalogInput{return CatalogInput{ModelsYAML:fixtureYML,CatalogRevision:"reviewed-catalog",BaseRevision:7,State:ChoiceState{SchemaVersion:1,ActivePreset:"Manual",ManualDisabled:[]ChoiceReference{},Presets:[]ChoicePreset{}},Selection:map[string]string{"lane":"mixed","model":"smart","thinking":"medium","advisor":"glance","spark":"on","fast":"off","prewalk":"off","planyolo":"off","fallback":"on"}}}

func TestNativeAnalysisUsesExactChoices(t *testing.T){
 p:=nativeCatalogInput()
 payload,_:=json.Marshal(p)
 raw,err:=Execute("analysis-plan",payload,fixtureServices{"broker/metadata":nativeMetadata})
 if err!=nil{t.Fatal(err)}
 var out AnalysisPlan;if err=json.Unmarshal(raw,&out);err!=nil{t.Fatal(err)}
 if out.BaseRevision!=7||out.CatalogRevision!="reviewed-catalog"||!out.Ready{t.Fatalf("unbound analysis plan: %+v",out)}
 if len(out.Routing)==0||out.Routing[0].Lead!="openai-codex/gpt-5.6-sol:medium"{t.Fatalf("wrong actual route: %+v",out.Routing)}
 if !strings.Contains(out.ConfigYAML,"modelRoles:")||!strings.Contains(out.ConfigYAML,"openai-codex/gpt-5.6-sol:medium"){t.Fatal("analysis config disagrees with routing")}
 p.State.ManualDisabled=[]ChoiceReference{{Provider:openAIProvider,IdentityKey:"codex"}}
 payload,_=json.Marshal(p)
 if _,err=Execute("analysis-plan",payload,fixtureServices{"broker/metadata":nativeMetadata});err==nil{t.Fatal("disabled required provider was broadened into a launch")}
 p.State.ManualDisabled=[]ChoiceReference{{Provider:openAIProvider,IdentityKey:"old-identity"}}
 payload,_=json.Marshal(p)
 if _,err=Execute("analysis-plan",payload,fixtureServices{"broker/metadata":nativeMetadata});err==nil{t.Fatal("stale disabled identity was silently pruned")}
}

func TestNativeInspectRemainsUsefulWithoutBroker(t *testing.T){
 payload,_:=json.Marshal(nativeCatalogInput())
 raw,err:=Execute("inspect",payload,nil);if err!=nil{t.Fatal(err)}
 var out CatalogResult;if json.Unmarshal(raw,&out)!=nil{t.Fatal("invalid result")}
 if out.Ready||len(out.Routing)==0||!strings.Contains(string(raw),"broker_metadata_unavailable"){t.Fatal("missing broker hid catalog or claimed readiness")}
}

func TestNativeBoundaryRejectsAmbientAndCredentialInputs(t *testing.T){
 p:=nativeCatalogInput();payload,_:=json.Marshal(p)
 for _,bad:=range []string{
  strings.TrimSuffix(string(payload),"}")+`,"modelsFile":"/private/models.yml"}`,
  strings.TrimSuffix(string(payload),"}")+`,"baseRevision":8}`,
  strings.Replace(string(payload),`"selection":`, `"Selection":`,1),
  strings.Replace(string(payload),`"presets":[]`,`"presets":null`,1),
 }{if _,err:=Execute("inspect",[]byte(bad),nil);err==nil{t.Fatal("ambiguous/ambient input accepted")}}
 if _,err:=Execute("account-import",[]byte(`{"baseRevision":0}`),nil);err==nil{t.Fatal("retired import operation remains callable")}
 secrets:=strings.Replace(nativeMetadata,`"type":"oauth"`,`"type":"oauth","access":"secret-marker"`,1)
 if _,err:=Execute("analysis-plan",payload,fixtureServices{"broker/metadata":secrets});err==nil{t.Fatal("credential-bearing metadata crossed native boundary")}
}

func TestUsageKeepsSourceObservationAndUnknownAmount(t *testing.T){
 now:=time.Unix(2000000000,0)
 accounts:=map[string][]account{openAIProvider:{{Provider:openAIProvider,IdentityKey:"codex",Email:"codex@example.test"}}}
 raw:=[]byte(`{"reports":[{"provider":"openai-codex","fetchedAt":1999999900000,"metadata":{"email":"codex@example.test"},"limits":[{"label":"30 days","scope":{"windowId":"30d"},"amount":{"usedFraction":0.4},"window":{"resetsAt":2000000100000}},{"label":"unreported","scope":{"windowId":"future"},"amount":{},"window":{}}]}]}`)
 a:=parseAvailability(accounts,true,raw,now.Unix())
 out:=projectUsageAPI(a,true,true,false,defaultAccountSelectionState(),now,now)
 for _,provider:=range out.Providers{if provider.Provider!=openAIProvider{continue};wins:=provider.Accounts[0].Windows
  if wins[0].ObservedAt!=1999999900||wins[0].ResetsAt!=2000000100||wins[0].UsedPercent!=40{t.Fatalf("source observation replaced by fetch time: %+v",wins[0])}
  if wins[1].Status!="missing"||wins[1].ObservedAt!=0{t.Fatalf("missing fraction claimed as measured zero: %+v",wins[1])}
 }
}
