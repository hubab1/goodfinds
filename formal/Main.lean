import Goodfinds.SellerAction
open Lean

structure SellerCase where
  state : Goodfinds.SellerAction.State
  context : Goodfinds.SellerAction.Context
  event : Goodfinds.SellerAction.Event
  deriving FromJson

def main : IO Unit := do
  let input ← (← IO.getStdin).readToEnd
  let cases ← IO.ofExcept do
    let json ← Json.parse input
    fromJson? (α := Array SellerCase) json
  let answers := cases.map fun item => Goodfinds.SellerAction.step item.state item.context item.event
  (← IO.getStdout).putStrLn (toJson answers).compress
