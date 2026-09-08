package domain

import (
 "bytes"
 "io"
 "math"
 "strings"
 "gopkg.in/yaml.v3"
)

func validateModelsYAML(raw []byte) error {
 if len(raw)==0 || len(raw)>MaxInput{return errInvalid}
 var node yaml.Node
 dec:=yaml.NewDecoder(bytes.NewReader(raw))
 if dec.Decode(&node)!=nil || dec.Decode(&yaml.Node{})!=io.EOF{return errInvalid}
 if validYAMLNode(&node,0)!=nil{return errInvalid}
 var doc struct { Probed bool `yaml:"probed"`; Models map[string]catModel `yaml:"models"` }
 dec=yaml.NewDecoder(bytes.NewReader(raw));dec.KnownFields(true)
 if dec.Decode(&doc)!=nil || len(doc.Models)==0{return errInvalid}
 seen:=map[string]bool{}
 for key,m:=range doc.Models {
  if !safeModelID.MatchString(key)||!safeModelID.MatchString(m.ID)||seen[m.ID]||m.Context<=0{return errInvalid}
  seen[m.ID]=true
  if m.Bucket!="" && !safeModelID.MatchString(m.Bucket){return errInvalid}
  for _,v:=range []float64{m.CostIn,m.CostOut,m.Speed,m.TTFT}{if math.IsNaN(v)||math.IsInf(v,0)||v<0{return errInvalid}}
  if m.Speed<=0{return errInvalid}
 }
 return nil
}

func validYAMLNode(n *yaml.Node,depth int)error{
 if depth>16||n.Kind==yaml.AliasNode||n.Anchor!=""||strings.ContainsRune(n.Value,0){return errInvalid}
 if n.Kind==yaml.MappingNode {
  seen:=map[string]bool{}
  for i:=0;i<len(n.Content);i+=2 {k:=n.Content[i];if k.Kind!=yaml.ScalarNode||k.Tag!="!!str"||seen[k.Value]{return errInvalid};seen[k.Value]=true}
 }
 for _,c:=range n.Content{if validYAMLNode(c,depth+1)!=nil{return errInvalid}}
 return nil
}
