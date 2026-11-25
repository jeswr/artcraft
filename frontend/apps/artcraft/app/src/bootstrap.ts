// Entry of the classic, synchronous script emitted as /pod-bootstrap.js (see
// pod-bootstrap-plugin.ts). It is the first element of <head> in index.html.
import { runBootstrap } from "./bootstrap-core";

runBootstrap();
