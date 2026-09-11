// tabshot is a screenshot-only bridge between a local command line and one
// browser tab. The daemon half (`tabshot serve`) queues commands for the
// browser extension; every other subcommand is a client that hands one command
// to the daemon and prints what came back.
//
// The boundary that matters is the shape of the answer, not the permissions:
// the extension returns pixels and yes/no, never text, DOM, cookies or URLs.
package main

import (
	"fmt"
	"os"

	"github.com/faradey/tabshot/internal/client"
	"github.com/faradey/tabshot/internal/daemon"
)

const usage = `tabshot — pixels in, coordinates out; the page itself never leaves the browser

  tabshot serve [--port N]                       run the local daemon (foreground)
  tabshot token [--copy]                         print (or copy) the token the extension must be given

Every command below names a domain; the extension finds the tab itself and
refuses a domain that is not on its allow list.

  tabshot status  [--domain D]                   extension connected? tab for D open?
  tabshot shot    --domain D [--out F] [--width N | --full] [--zoom X,Y,W,H]
  tabshot click   --domain D X Y                 left click at viewport point
  tabshot type    --domain D [--at X,Y] TEXT     insert text into the focused (or clicked) field
  tabshot key     --domain D Enter|Tab|Escape|Backspace|ArrowDown|...
  tabshot scroll  --domain D DX DY [--at X,Y]    scroll the scrollable under the point (default: centre)
  tabshot refresh --domain D
  tabshot resize  --domain D W H                 make the viewport exactly W×H CSS pixels

Common flags: --shot F (take a screenshot after the action), --timeout SEC.
Flags go before positional arguments. Coordinates are CSS pixels of the
viewport. Screenshots are downscaled to 800 px wide unless --width or --full
says otherwise; the output line gives the factor to multiply image pixels by.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var code int
	switch cmd {
	case "serve":
		code = daemon.Run(args)
	case "token":
		code = client.Token(args)
	case "status", "shot", "click", "type", "key", "scroll", "refresh", "resize":
		code = client.Run(cmd, args)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		code = 2
	}
	os.Exit(code)
}
