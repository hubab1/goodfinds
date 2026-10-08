import Goodfinds.SellerActionProofs

open Lean Elab Command

/-- Audit theorem dependencies, including admitted proofs hidden in imported helpers. -/
elab "#audit_formal_proofs" : command => do
  let mut count : Nat := 0
  for (name, info) in (← getEnv).constants.toList do
    if (`Goodfinds).isPrefixOf name then
      if let .thmInfo _ := info then
        count := count + 1
        for axiomName in ← collectAxioms name do
          unless #[``propext, ``Classical.choice, ``Quot.sound].contains axiomName do
            throwError "{name} depends on unapproved axiom {axiomName}"
  logInfo m!"Audited {count} specification theorems: only standard logical axioms"

#audit_formal_proofs
