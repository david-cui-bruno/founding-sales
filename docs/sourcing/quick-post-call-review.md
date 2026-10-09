# Quick post-call review

Source implementation for #455 extends the existing **Notes & tasks** interaction. It adds a small one-minute review above the existing notes editor, rather than creating a second outcome system.

The review asks for missing workflow, main problem, commitments and next step. Supported stated items from current or partial analysis suppress repeated questions; inference, unresolved item review reasons, dismissed corrections and stale sources do not. Free-form notes are not automatically interpreted as confirmed facts. A human can skip a question or choose **Unknown**, which appends an explicit unknown to the existing draft and clears its prior completeness checkbox. A confirmed no-show or cancelled meeting requires no conversation facts and still allows optional notes. Nothing is saved until **Save notes** is clicked. Humans may still explicitly confirm that their notes are sufficient through the existing checkbox.

Attendance stays under the existing **Attended / No-show** controls and qualification under **Demo qualification**. A scheduled end or saved notes never marks a meeting held or qualified. Commitment evidence, owner/deadline confirmation, existing tasks and notes revision checks retain their original rules. Unknown answers create no automatic task or commitment. Recording, transcription and analysis settings are neither enabled nor modified by review.

The same session-scoped, per-meeting draft memory retains notes when navigating away and back. A new meeting does not inherit them and a new session clears them. Refresh retains unsaved text and visibly reports changed sources. Definitively missing notes retain the existing revocation behavior.

## Verification

Four new public UI slices were observed red before green: missing-fact prompts and unknown note saving; supported partial facts versus stale/inferred facts; unknown completeness with return-navigation/session isolation; and optional notes without conversation-fact prompts after a no-show. Real PostgreSQL preservation tests use the existing public notes/outcomes/qualification/settings operations to verify partial unknown storage, scheduled-end attendance, stale revision rejection, meeting isolation and unchanged paid/recording controls. These domain behaviors were already implemented; this ticket does not claim a new backend fix.

This is source completion. Backend release and signed desktop publication/installed acceptance remain separate evidence gates. Automatic admission, routine replies, autonomous calling, budgets, caps and original Shirley launch/stop state are outside this change.
