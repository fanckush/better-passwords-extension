# Credential operation lifetime

The latest password choice wins across saved and generated fills, even if an earlier encryption or field probe finishes later. A fill keeps its original expected origin.

Lock invalidates pending key import, encrypted queries and connection opening. Generated-password save polling uses its originating client and stops on Lock, tab close or replacement. Stale work cannot deliver a secret or restore the generated cache. A browser message already delivered cannot be recalled.

Use forced asynchronous pauses and fake credentials in the real Session, protocol and background interfaces. The screen-lock default is a separate policy change.
