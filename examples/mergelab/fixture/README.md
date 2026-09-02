# MergeLab Fixture Repository

This is the companion fixture for the MergeLab cookbook example. It contains a
tiny TypeScript/Express store with three pull requests designed so that every PR
passes alone, but exactly one pair fails together.

## The scenario

- **Base:** `/api/cart` returns `{ count: 2 }`.
- **PR A:** Changes the cart response to `{ cart: { itemCount: 2 } }` and updates
the cart UI to read the new shape.
- **PR B:** Adds a checkout UI that reads the legacy `count` field.
- **PR C:** Adds an unrelated product filter.

Expected MergeLab matrix:

| Candidate | Verdict |
|---|---|
| PR A | compatible |
| PR B | compatible |
| PR C | compatible |
| A + B | cross-PR regression (checkout reads missing `count`) |
| A + C | compatible |
| B + C | compatible |

## Files

- Base fixture files live in this directory.
- Patch files for each PR live in `../patches/`.

## Publish the fixture to GitHub

Create a new public repository and push the base fixture, then create three PRs
from the patch files:

```bash
# In a fresh directory outside this repo:
git init -b main
cp -r /path/to/mergelab/fixture/* .
git add .
git commit -m "base: cart api returns { count }"
git remote add origin https://github.com/<your-user>/mergelab-fixture.git
git push origin main

# Create branches and patches from ../patches/
git checkout -b pr-a && git am < /path/to/mergelab/patches/pr-a.patch
git push origin pr-a
git checkout main && git checkout -b pr-b && git am < /path/to/mergelab/patches/pr-b.patch
git push origin pr-b
git checkout main && git checkout -b pr-c && git am < /path/to/mergelab/patches/pr-c.patch
git push origin pr-c

# Open three pull requests from pr-a, pr-b, pr-c into main.
# Note their PR numbers.
```

## Run MergeLab against your published fixture

```bash
cd ..
export SOLARI_API_KEY=slr_live_...
npm start -- \
  --repo https://github.com/<your-user>/mergelab-fixture \
  --prs <pr-a>,<pr-b>,<pr-c> \
  --config ./mergelab.config.fixture.json
```

## Run fixture tests locally

```bash
cd fixture
npm install
npm test
```

Test combinations locally:

```bash
git checkout main
# A+B: unit tests pass; browser verification would fail
git merge --no-ff --no-edit pr-a && git merge --no-ff --no-edit pr-b && npm test
git reset --hard main

# A+C: passes
git merge --no-ff --no-edit pr-a && git merge --no-ff --no-edit pr-c && npm test
git reset --hard main

# B+C: passes
git merge --no-ff --no-edit pr-b && git merge --no-ff --no-edit pr-c && npm test
```
