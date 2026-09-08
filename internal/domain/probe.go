package domain

import (
 "bytes"
 "context"
 "encoding/json"
 "os/exec"
 "strconv"
 "time"
)

const ompTool = "/runtime/bin/omp"

// The declared tool binding supplies OMP's native, scoped runtime configuration.
// No host PATH, Code environment, personal settings, or credential file is read.
func runOMP(args []string)([]byte,error){
 ctx,cancel:=context.WithTimeout(context.Background(),10*time.Minute);defer cancel()
 cmd:=exec.CommandContext(ctx,ompTool,args...)
 cmd.Env=[]string{"HOME=/runtime/home","XDG_CONFIG_HOME=/runtime/home/.config","XDG_CACHE_HOME=/runtime/home/.cache","TMPDIR=/tmp"}
 var out boundedOutput
 cmd.Stdout=&out
 err:=cmd.Run()
 if out.overflow || ctx.Err()!=nil{return nil,errInvalid}
 if err!=nil && out.buffer.Len()==0{return nil,errInvalid}
 return out.buffer.Bytes(),nil
}

type boundedOutput struct{buffer bytes.Buffer;overflow bool}
func(b *boundedOutput)Write(p []byte)(int,error){if b.overflow||len(p)>MaxOutput-b.buffer.Len(){b.overflow=true;return 0,errInvalid};return b.buffer.Write(p)}

func generateNativeCatalog(service Services)(any,error){
 raw,err:=runOMP([]string{"models","--json"});if err!=nil{return nil,err}
 // Model facts are projected later; only syntactically safe catalog ids can
 // become positional selectors or rendered YAML scalars.
 var models ompModels
 if json.Unmarshal(raw,&models)!=nil||len(models.Models)==0{return nil,errInvalid}
 for _,m:=range models.Models{if !safeModelID.MatchString(m.ID){return nil,errInvalid}}
 selectors,err:=benchSelectors(raw);if err!=nil||len(selectors)==0{return nil,errInvalid}
 args:=append([]string{"bench"},selectors...)
 args=append(args,"--json","--runs",strconv.Itoa(1),"--max-tokens",strconv.Itoa(4),"--profile","chat","--prompt","Reply with the single word: ok")
 report,err:=runOMP(args);if err!=nil{return nil,err}
 facts,err:=parseBenchFacts(report);if err!=nil{return nil,err}
 usage,err:=serviceCall(service,"broker","usage",map[string]any{});if err!=nil{return nil,err}
 source,err:=scaffoldModels(raw,facts,readSpecialTiers(usage));if err!=nil{return nil,err}
 if _,err=loadCatalogBytes([]byte(source),"native catalog");err!=nil{return nil,err}
 return struct{SchemaVersion int `json:"schemaVersion"`;ModelsYAML string `json:"modelsYaml"`;Probed bool `json:"probed"`}{1,source,true},nil
}
