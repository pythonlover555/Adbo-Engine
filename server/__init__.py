"""Local backend for the Adbo-Engine browser extension.

The nav-extension drives the redirect loop and the sign-up funnel in the
browser; this server supplies the data it enters (random identities and
registration details). Keeping that generation server-side lets the
(sandboxed) extension stay thin.
"""
