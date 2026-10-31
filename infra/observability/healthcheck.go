package main
import("net/http";"os";"time")
func main(){ c:=http.Client{Timeout:2*time.Second}; r,e:=c.Get(os.Args[1]);if e!=nil{os.Exit(1)};defer r.Body.Close();if r.StatusCode<200||r.StatusCode>=300{os.Exit(1)} }
