"""Local evaluation server for the YC co-founder filter extension.

The browser extension scrapes each candidate profile and POSTs it here;
this server runs the OpenAI evaluation, applies the keep/skip rule, and
appends matches to an Excel file. Keeping the key and the file I/O on the
server side is what lets the (sandboxed, secret-less) extension stay thin.
"""
