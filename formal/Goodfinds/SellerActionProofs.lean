import Goodfinds.SellerAction

namespace Goodfinds.SellerAction

theorem initial_valid (kind : Kind) (draft : String) : Valid (initial kind draft) := by
  simp [Valid, initial, noPermit]

theorem expire_valid (s : State) (now : Int) (valid : Valid s) : Valid (expire s now) := by
  unfold expire
  split
  · split <;> cases hStatus : s.status <;> simp_all [Valid, noPermit]
  · exact valid

theorem step_preserves_valid (s next : State) (c : Context) (event : Event)
    (valid : Valid s) (accepted : step s c event = some next) : Valid next := by
  cases event <;> simp only [step] at accepted
  · split at accepted <;> cases accepted <;> simp_all [Valid, noPermit]
  · split at accepted
    · cases accepted; exact valid
    · split at accepted
      · cases accepted
        split <;> cases hStatus : s.status <;> simp_all [Valid, noPermit, terminal]
      · contradiction
  · split at accepted
    · split at accepted
      · cases accepted
        simp_all [canPrepare, Valid, noPermit]
      · cases accepted
        simp_all [canPrepare, Valid, noPermit]
    · contradiction
  · split at accepted
    · cases accepted
      cases hStatus : s.status <;> simp_all [Valid, noPermit]
    · contradiction
  · cases accepted
    exact expire_valid _ _ valid
  · split at accepted
    · cases accepted; exact valid
    · split at accepted
      · cases accepted
        rename_i result _ _
        cases result <;> simp_all [canReport, Valid, noPermit]
      · contradiction

theorem reachable_valid (valid : Valid start) (history : Reachable start s) : Valid s := by
  induction history with
  | refl => exact valid
  | next _ accepted ih => exact step_preserves_valid _ _ _ _ ih accepted

theorem at_most_one_permit (history : Reachable (initial kind draft) s) : s.permits ≤ 1 :=
  (reachable_valid (initial_valid kind draft) history).1

theorem uncertain_rejects_prepare (s : State) (c : Context) (h : s.status = .uncertain) :
    step s c .prepare = none := by
  simp [step, canPrepare, h]

theorem uncertain_rejects_cancel (s : State) (c : Context) (h : s.status = .uncertain) :
    step s c .cancel = none := by
  simp [step, h]

theorem wrong_token_rejects (s : State) (c : Context) (lease : Lease)
    (h : s.lease = some lease) (different : c.token ≠ some lease.token) :
    canPrepare s c = false ∧ ∀ result, canReport s c result = false := by
  simp [canPrepare, canReport, owns, h, different]

theorem expired_token_rejects (s : State) (c : Context) (lease : Lease)
    (h : s.lease = some lease) (expired : lease.expiresAt ≤ c.now) :
    canPrepare s c = false ∧ ∀ result, canReport s c result = false := by
  have htime : ¬c.now < lease.expiresAt := by omega
  simp [canPrepare, canReport, owns, h, htime]

theorem sent_requires_exact_evidence (s : State) (c : Context)
    (accepted : canReport s c .sent = true) :
    c.evidenceMatches = true ∧ c.identityValid = true ∧ c.routeValid = true := by
  simp_all [canReport]

theorem step_preserves_draft (s next : State) (c : Context) (event : Event)
    (accepted : step s c event = some next) : next.draft = s.draft := by
  cases event with
  | handoff =>
    simp only [step] at accepted
    cases accepted
    split <;> rfl
  | claim =>
    simp only [step] at accepted
    split at accepted
    · cases accepted; rfl
    · split at accepted
      · cases accepted; rfl
      · contradiction
  | prepare =>
    simp only [step] at accepted
    split at accepted
    · split at accepted <;> cases accepted <;> rfl
    · contradiction
  | report result =>
    simp only [step] at accepted
    split at accepted
    · cases accepted; rfl
    · split at accepted
      · cases accepted; rfl
      · contradiction
  | cancel =>
    simp only [step] at accepted
    split at accepted
    · cases accepted; rfl
    · contradiction
  | expire =>
    simp only [step] at accepted
    cases accepted
    unfold expire
    split <;> rfl

theorem history_preserves_draft (history : Reachable start s) : s.draft = start.draft := by
  induction history with
  | refl => rfl
  | next _ accepted ih => exact (step_preserves_draft _ _ _ _ accepted).trans ih

end Goodfinds.SellerAction
