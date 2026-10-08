import Lean
open Lean

namespace Goodfinds.SellerAction

inductive Status where
  | awaiting_handoff | requested | running | ready_to_send | sent | checked
  | not_sent | uncertain | blocked | cancelled
  deriving Repr, DecidableEq, ToJson, FromJson
inductive Kind where
  | send | check
  deriving Repr, DecidableEq, ToJson, FromJson
structure Lease where
  token : String
  expiresAt : Int
  deriving Repr, ToJson, FromJson
structure State where
  status : Status
  kind : Kind
  draft : String
  lease : Option Lease
  -- Ghost history: number of permits issued for this immutable action ID.
  permits : Nat
  deriving Repr, ToJson, FromJson
structure Context where
  now : Int
  token : Option String
  nextToken : String
  workerPresent : Bool
  routeValid : Bool
  identityValid : Bool
  draftReady : Bool
  conversationOpen : Bool
  evidencePresent : Bool
  evidenceMatches : Bool
  deriving Repr, ToJson, FromJson
inductive Event where
  | handoff | claim | prepare | cancel | expire
  | report (result : Status)
  deriving Repr, ToJson, FromJson

def terminal (status : Status) : Bool :=
  status = .sent || status = .checked || status = .not_sent || status = .cancelled
def noPermit (status : Status) : Bool :=
  status = .awaiting_handoff || status = .requested || status = .running ||
  status = .blocked || status = .cancelled
def Valid (s : State) : Prop :=
  s.permits ≤ 1 ∧ (noPermit s.status = true → s.permits = 0) ∧
  (s.status = .ready_to_send → s.kind = .send ∧ s.permits = 1)
def initial (kind : Kind) (reviewedDraft : String) : State :=
  ⟨.awaiting_handoff, kind, reviewedDraft, none, 0⟩
def owns (s : State) (c : Context) : Bool :=
  match s.lease with
  | none => false
  | some lease => c.now < lease.expiresAt && c.token = some lease.token
def liveLease (s : State) (now : Int) : Bool :=
  match s.lease with
  | none => false
  | some lease => now < lease.expiresAt
def canClaim (s : State) (c : Context) : Bool :=
  !terminal s.status && !liveLease s c.now && c.workerPresent && c.routeValid
-- Readiness pauses execution before a send; route/identity failures reject instead.
def canPrepare (s : State) (c : Context) : Bool :=
  owns s c && s.kind = .send && s.status = .running && c.routeValid &&
  c.identityValid && (c.draftReady → c.conversationOpen)
def canReport (s : State) (c : Context) (result : Status) : Bool :=
  owns s c && (s.status = .running || s.status = .ready_to_send || s.status = .uncertain) &&
  c.evidencePresent &&
  match result with
  | .sent => s.kind = .send && (s.status = .ready_to_send || s.status = .uncertain) &&
      c.evidenceMatches && c.identityValid && c.routeValid
  | .checked => s.kind = .check && c.identityValid && c.routeValid
  | .not_sent => s.kind = .check || (c.identityValid && c.routeValid)
  | .blocked => s.status = .running
  | .uncertain => true
  | _ => false
def expire (s : State) (now : Int) : State :=
  if (s.status = .running || s.status = .ready_to_send) &&
      (s.lease.any fun lease => lease.expiresAt ≤ now) then
    { s with status := if s.kind = .send then .uncertain else .blocked }
  else s
-- The server reconciles lease expiry before actions. Call expire explicitly in histories.
def step (s : State) (c : Context) : Event → Option State
  | .handoff => some (if s.status = .awaiting_handoff then { s with status := .requested } else s)
  | .claim =>
      if terminal s.status then some s
      else if canClaim s c then some { s with
        status := if s.status = .uncertain || s.status = .ready_to_send then .uncertain else .running
        lease := some ⟨c.nextToken, c.now + 300000⟩ }
      else none
  | .prepare => if canPrepare s c then
      if c.draftReady then some { s with status := .ready_to_send, permits := s.permits + 1 }
      else some { s with status := .blocked }
    else none
  | .report result =>
      if (s.status = .sent || s.status = .checked || s.status = .not_sent) && s.status = result
        then some s
      else if canReport s c result then some { s with status := result, lease := none } else none
  | .cancel => if s.status = .awaiting_handoff || s.status = .requested || s.status = .blocked
      then some { s with status := .cancelled } else none
  | .expire => some (expire s c.now)
inductive Reachable : State → State → Prop where
  | refl : Reachable s s
  | next : Reachable start s → step s c event = some next → Reachable start next

end Goodfinds.SellerAction
