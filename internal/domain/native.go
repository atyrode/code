// Package domain computes Code product choices. It owns no durable state,
// credential resolver, terminal, workspace, or execution-policy authority.
package domain

import (
 "github.com/atyrode/code/internal/wirejson"
 "encoding/json"
 "errors"
 "maps"
 "regexp"
 "slices"
 "strings"
 "time"
)

const MaxInput = 64 << 10
const MaxOutput = 1 << 20
var errInvalid = errors.New("invalid operation data")

// Services is the native parent's authorized, secret-free service projection.
// Implementations must never return upstream credentials, even for read calls.
type Services interface { Call(service, operation string, input map[string]any) ([]byte, error) }

type ChoiceReference struct { Provider string `json:"provider"`; IdentityKey string `json:"identityKey"` }
type ChoicePreset struct { Name string `json:"name"`; Disabled []ChoiceReference `json:"disabled"` }
type ChoiceState struct {
 SchemaVersion int `json:"schemaVersion"`
 ActivePreset string `json:"activePreset"`
 ManualDisabled []ChoiceReference `json:"manualDisabled"`
 Presets []ChoicePreset `json:"presets"`
}
type ChoiceInput struct { State ChoiceState `json:"state"`; BaseRevision int64 `json:"baseRevision"` }
type CatalogInput struct {
 ModelsYAML string `json:"modelsYaml"`
 CatalogRevision string `json:"catalogRevision"`
 Selection map[string]string `json:"selection"`
 State ChoiceState `json:"state"`
 BaseRevision int64 `json:"baseRevision"`
}
type SuggestInput struct {
 ModelsYAML string `json:"modelsYaml"`
 CatalogRevision string `json:"catalogRevision"`
 Selection map[string]string `json:"selection"`
 State ChoiceState `json:"state"`
 BaseRevision int64 `json:"baseRevision"`
 Prompt string `json:"prompt"`
}
type AccountSetInput struct {
 Provider string `json:"provider"`; Identity string `json:"identity"`; Enabled bool `json:"enabled"`
 State ChoiceState `json:"state"`; BaseRevision int64 `json:"baseRevision"`
}
type PresetInput struct {
 Name string `json:"name"`; State ChoiceState `json:"state"`; BaseRevision int64 `json:"baseRevision"`
}
type PresetWriteInput struct {
 Name string `json:"name"`; Disabled []ChoiceReference `json:"disabled"`
 State ChoiceState `json:"state"`; BaseRevision int64 `json:"baseRevision"`
}
type AccountInput struct { Provider string `json:"provider"`; Identity string `json:"identity"` }
type accountsResult struct { accountAPIResult; BaseRevision int64 `json:"baseRevision"` }
type usageResult struct { usageAPIResult; BaseRevision int64 `json:"baseRevision"` }
type Route struct { Role string `json:"role"`; AgentBacked bool `json:"agentBacked"`; Lead string `json:"lead"`; Fallback []string `json:"fallback"` }
type Facet struct { Key string `json:"key"`; Values []string `json:"values"` }
type Estimates struct { CostScore int `json:"costScore"`; SpeedScore int `json:"speedScore"`; ScaleMin int `json:"scaleMin"`; ScaleMax int `json:"scaleMax"` }
type CatalogResult struct {
 SchemaVersion int `json:"schemaVersion"`
 ObservedAt int64 `json:"observedAt"`
 BaseRevision int64 `json:"baseRevision"`
 CatalogRevision string `json:"catalogRevision"`
 Selection map[string]string `json:"selection"`
 Facets []Facet `json:"facets"`
 Routing []Route `json:"routing"`
 Estimates Estimates `json:"estimates"`
 Ready bool `json:"ready"`
 Refusals []string `json:"refusals"`
}
type AnalysisPlan struct {
 CatalogResult
 ConfigYAML string `json:"configYaml"`
 Flags []string `json:"flags"`
 AccountPool map[string][]string `json:"accountPool"`
}

type model struct {
 sel map[string]string
 facets []facet
 generated map[string][]string
 facts map[string]modelFact
 advisors map[string][]string
 connected map[string]bool
 providersResolved bool
 avail availability
 now time.Time
 catalog *catalog
}
var modelRe = regexp.MustCompile(`([a-z][a-z0-9._/-]*):(minimal|low|medium|high|xhigh|max)\b`)
var safeModelID = regexp.MustCompile(`^[a-z][a-z0-9._/-]*$`)

func nativeState(s ChoiceState, revision int64) (accountSelectionState, error) {
 if revision < 0 || revision > 9007199254740991 { return accountSelectionState{}, errInvalid }
 raw, err := json.Marshal(s)
 if err != nil { return accountSelectionState{}, errInvalid }
 return decodePortableAccountState(string(raw))
}

func newModel(p CatalogInput, accounts map[string][]account, now time.Time) (model, error) {
 if strings.TrimSpace(p.CatalogRevision) == "" { return model{}, errInvalid }
 c, err := loadCatalogBytes([]byte(p.ModelsYAML), "native catalog")
 if err != nil { return model{}, errInvalid }
 m := model{catalog:c, sel:maps.Clone(p.Selection), facets:facetDefs(nil), generated:map[string][]string{},
  facts:map[string]modelFact{}, connected:connectedPools(accounts), providersResolved:true, now:now}
 for _, k := range c.keys {
  v := c.models[k]
  m.facts[v.ID] = modelFact{in:v.CostIn, out:v.CostOut, speed:v.Speed, ttft:v.TTFT, bucket:v.Bucket, pool:v.Pool}
 }
 for i := range m.facets { if m.facets[i].key == "lane" { m.facets[i].values = c.lanes() } }
 m.advisors = parseAdvisors(strings.Split(c.renderAdvisors(), "\n")[1:])
 if err := m.validateSelection(); err != nil { return model{}, err }
 lines := strings.Split(c.renderCombo(m.sel["lane"],m.sel["model"],m.sel["thinking"],m.sel["spark"]=="on"),"\n")
 m.generated[comboID(m.sel)] = lines[2:]
 return m,nil
}

func (m model) validateSelection() error {
 if len(m.sel) != len(m.facets) { return errInvalid }
 for _, f := range m.facets { if !slices.Contains(f.values,m.sel[f.key]) { return errInvalid } }
 lane := m.sel["lane"]
 spark := m.sel["spark"] == "on"
 if !m.catalog.genValid(lane,m.sel["model"],spark) || (spark && m.catalog.specialKey("spark")=="") { return errInvalid }
 if m.sel["fast"]=="on" && len(laneServiceTiers(lane))==0 { return errInvalid }
 return nil
}

func (m model) laneUsable(lane string) bool { return slices.Contains(m.catalog.lanes(),lane) && laneAvailable(lane,m.connected) }

func projectCatalog(m model, p CatalogInput, now time.Time) CatalogResult {
 out := CatalogResult{SchemaVersion:1, ObservedAt:now.Unix(), BaseRevision:p.BaseRevision, CatalogRevision:p.CatalogRevision,
  Selection:m.sel, Facets:[]Facet{}, Routing:[]Route{}, Estimates:Estimates{m.costScore(),m.speedScore(),1,5}, Ready:m.laneUsable(m.sel["lane"]), Refusals:[]string{}}
 if !out.Ready { out.Refusals=append(out.Refusals,"selected_provider_unavailable") }
 for _, f := range m.facets {
  values:=slices.Clone(f.values)
  if f.key=="model" { values=nil; for _, v:=range f.values { if m.catalog.genValid(m.sel["lane"],v,false) {values=append(values,v)} } }
  if f.key=="spark" && (!laneHostsSpecial(m.sel["lane"],"spark") || m.catalog.specialKey("spark")=="") {values=[]string{"off"}}
  if f.key=="fast" && len(laneServiceTiers(m.sel["lane"]))==0 {values=[]string{"off"}}
  out.Facets=append(out.Facets,Facet{f.key,values})
 }
 for _, row:=range m.currentRows() {
  tokens:=modelRe.FindAllString(row,-1)
  if len(tokens)==0 {continue}
  r:=Route{Role:roleOf(row),AgentBacked:strings.Contains(row,"●"),Lead:m.prefixed(tokens[0]),Fallback:[]string{}}
  if m.sel["fallback"]!="off" { for _, token:=range tokens[1:] {r.Fallback=append(r.Fallback,m.prefixed(token))} }
  out.Routing=append(out.Routing,r)
 }
 return out
}

func selectedAccounts(accounts map[string][]account, state accountSelectionState) (map[string][]account,error) {
 disabled:=state.CurrentDisabled()
 // A stale identity is not silently pruned: that could widen an approved pool.
 for key:=range disabled {if _,err:=resolveAccountAPIReference(accounts,key.Provider,key.IdentityKey);err!=nil{return nil,errInvalid}}
 out:=emptyAccounts()
 for provider, rows:=range accounts {for _, row:=range rows {if !selectionDisabled(disabled,row){out[provider]=append(out[provider],row)}}}
 return out,nil
}

// Execute is the only product-operation entrypoint. Inputs are native snapshots;
// results propose state changes against BaseRevision, never commit them locally.
func Execute(operation string, payload []byte, service Services) ([]byte,error) {
 if len(payload)>MaxInput {return nil,errInvalid}
 now:=time.Now().UTC()
 result,err:=executeOperation(operation,payload,service,now)
 if err!=nil{return nil,errInvalid}
 raw,err:=json.Marshal(result)
 if err!=nil || len(raw)>MaxOutput{return nil,errInvalid}
 return raw,nil
}

func executeOperation(operation string, payload []byte, service Services, now time.Time) (any,error) {
 switch operation {
 case "inspect","analysis-plan":
  var p CatalogInput
  if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid}
  state,err:=nativeState(p.State,p.BaseRevision);if err!=nil{return nil,err}
  accounts,accountErr:=loadNativeAccounts(service,now)
  if accountErr!=nil && operation=="analysis-plan" {return nil,accountErr}
  selected:=accounts
  if accountErr==nil {selected,err=selectedAccounts(accounts,state);if err!=nil{return nil,err}}
  m,err:=newModel(p,selected,now);if err!=nil{return nil,err}
  if accountErr!=nil {m.providersResolved=false}
  out:=projectCatalog(m,p,now)
  if accountErr!=nil {out.Ready=false;out.Refusals=append(out.Refusals,"broker_metadata_unavailable")}
  if operation=="inspect" {return out,nil}
  if !out.Ready{return nil,errInvalid}
  pool:=map[string][]string{}
  for _, provider:=range providerRegistry {if !provider.Metered{continue};pool[provider.ID]=[]string{};for _, a:=range selected[provider.ID]{pool[provider.ID]=append(pool[provider.ID],a.IdentityKey)}}
  flags:=m.sessionFlags();if flags==nil{flags=[]string{}}
  return AnalysisPlan{out,m.genConfigYAML(),flags,pool},nil
 case "suggest":
  var p SuggestInput
  if wirejson.Decode(payload,&p,true)!=nil || strings.TrimSpace(p.Prompt)=="" {return nil,errInvalid}
  return nativeSuggest(p,service,now)
 case "accounts-list","usage":
  var p ChoiceInput
  if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid}
  state,err:=nativeState(p.State,p.BaseRevision);if err!=nil{return nil,err}
  accounts,err:=loadNativeAccounts(service,now)
  if operation=="accounts-list" {if err!=nil{return nil,err};return accountsResult{projectAccountsAPI(operation,state,accounts,now),p.BaseRevision},nil}
  accountsOK:=err==nil
  raw,usageErr:=serviceCall(service,"broker","usage",map[string]any{})
  a:=parseAvailability(accounts,accountsOK,raw,now.Unix())
  if len(accounts[deepseekProvider])>0 {a.deepseek=&deepseekBalance{}}
  return usageResult{projectUsageAPI(a,usageErr==nil && a.ok,accountsOK,false,state,now,now),p.BaseRevision},nil
 case "account-clear-blocks","account-disable":
  var p AccountInput
  if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid}
  accounts,err:=loadNativeAccounts(service,now);if err!=nil{return nil,err}
  a,err:=resolveAccountAPIReference(accounts,p.Provider,p.Identity);if err!=nil || a.credentialID==""{return nil,errInvalid}
  op:="clear-blocks";if operation=="account-disable"{op="disable"}
  raw,err:=serviceCall(service,"broker",op,map[string]any{"credentialId":a.credentialID});if err!=nil{return nil,err}
  var reply struct{OK bool `json:"ok"`};if wirejson.Decode(raw,&reply,true)!=nil || !reply.OK{return nil,errInvalid}
  return struct{SchemaVersion int `json:"schemaVersion"`;Operation string `json:"operation"`;Account ChoiceReference `json:"account"`;OK bool `json:"ok"`}{1,operation,ChoiceReference{p.Provider,p.Identity},true},nil
 case "auth-status":
  var p struct{}
  if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid}
  raw,err:=serviceCall(service,"broker","health",map[string]any{});if err!=nil{return nil,err}
  var reply struct{OK bool `json:"ok"`;Version string `json:"version,omitempty"`}
  if wirejson.Decode(raw,&reply,true)!=nil{return nil,errInvalid}
  return reply,nil
 case "catalog-generate":
  var p struct{}
  if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid}
  return generateNativeCatalog(service)
 case "account-set","preset-create","preset-update","preset-activate","preset-delete":
  return mutateNativeChoice(operation,payload,service,now)
 default:return nil,errInvalid
 }
}

func mutateNativeChoice(operation string,payload []byte,service Services,now time.Time)(any,error){
 var choice ChoiceState;var revision int64;var provider,identity,name string;var enabled bool;var refs []ChoiceReference
 switch operation {
 case "account-set":var p AccountSetInput;if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid};choice,revision,provider,identity,enabled=p.State,p.BaseRevision,p.Provider,p.Identity,p.Enabled
 case "preset-create","preset-update":var p PresetWriteInput;if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid};choice,revision,name,refs=p.State,p.BaseRevision,strings.TrimSpace(p.Name),p.Disabled
 default:var p PresetInput;if wirejson.Decode(payload,&p,true)!=nil{return nil,errInvalid};choice,revision,name=p.State,p.BaseRevision,strings.TrimSpace(p.Name)
 }
 state,err:=nativeState(choice,revision);if err!=nil{return nil,err}
 accounts,err:=loadNativeAccounts(service,now);if err!=nil{return nil,err}
 switch operation {
 case "account-set":a,err:=resolveAccountAPIReference(accounts,provider,identity);if err!=nil{return nil,err};if err=setAccountAPIEnabled(&state,a,enabled);err!=nil{return nil,err}
 case "preset-activate":if !state.Activate(name){return nil,errInvalid}
 case "preset-delete":if _,ok:=state.Preset(name);!ok{return nil,errInvalid};if strings.EqualFold(state.ActiveName(),name){state.SetManualDisabled(state.CurrentDisabled())};state.DeletePreset(name)
 case "preset-create","preset-update":
  _,exists:=state.Preset(name);if (operation=="preset-create" && exists)||(operation=="preset-update" && !exists)||strings.ContainsAny(name,"\x00\r\n"){return nil,errInvalid}
  raw,_:=json.Marshal(refs);disabled,err:=accountAPIDisabled(string(raw),accounts);if err!=nil{return nil,err}
  if err=state.UpsertPreset(name,disabled);err!=nil{return nil,err};if operation=="preset-create"{state.Activate(name)}
 }
 return accountsResult{projectAccountsAPI(operation,state,accounts,now),revision},nil
}
