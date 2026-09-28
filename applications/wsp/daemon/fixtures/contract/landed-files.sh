set -u
home='{home}'; ledger='{home}/.wsp/provision/landed'
[ -f "$ledger" ] || exit 0
tab=$(printf "\t")
while IFS="$tab" read -r rel from at; do
  dest="$home/$rel"
  [ -f "$dest" ] || continue
  d=$(sha256sum "$dest" | cut -d" " -f1)
  [ "$d" = "$at" ] && printf 'wsp-own\t%s\n' "$rel"
done < "$ledger"
exit 0
