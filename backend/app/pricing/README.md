# Model Pricing Data

`models.json` is copied from SafeDep Gryph's bundled model pricing table:

https://github.com/safedep/gryph/blob/main/pricing/models.json

The Gryph repository is licensed Apache-2.0. The pricing values are expressed
as USD per 1 million tokens and are generated from models.dev pricing data.

To refresh:

```sh
curl -fsSL https://raw.githubusercontent.com/safedep/gryph/main/pricing/models.json \
  -o backend/app/pricing/models.json
```
