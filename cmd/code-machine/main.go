// code-machine is a private Manifold job executable, not a public Code CLI.
package main

import (
 "fmt"
 "os"

 "github.com/atyrode/code/internal/domain"
)

const failureMessage = "code-machine: operation failed"

func execute(args []string)([]byte,error){
 if len(args)!=2{return nil,errInvalid}
 service:=&nativeServices{}
 defer service.close()
 return domain.Execute(args[0],[]byte(args[1]),service)
}

func main(){
 result,err:=execute(os.Args[1:])
 if err!=nil{fmt.Fprintln(os.Stderr,failureMessage);os.Exit(1)}
 result=append(result,'\n')
 if _,err=os.Stdout.Write(result);err!=nil{fmt.Fprintln(os.Stderr,failureMessage);os.Exit(1)}
}
