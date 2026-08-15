# Seed passage — subjunctive highlighting (step 7)

Paste the block below into PasteView as **prose** — leave the "Song lyrics"
checkbox **unchecked**. Chunking mode is fixed at paste time, so a wrong choice
here means deleting and re-pasting.

It's a short narrative rather than a grammar drill, because the thing being
tested is whether the highlight helps during *ordinary reading*. Every form in
the task doc's testing list appears in it, and so does a set of decoys that must
come back **unhighlighted** — those are the important ones, since a false
positive teaches wrong grammar.

## The passage

```
La carta de mi abuela

Cuando llegué a casa, la carta de mi abuela ya estaba sobre la mesa del comedor.

Mi madre quería que la abriera delante de ella, pero yo preferí esperar un rato.

—No me digas que no tienes curiosidad —me dijo, sonriendo desde la cocina.

Le respondí que la leería más tarde, cuando estuviera solo.

Es posible que mi abuela haya escrito esas páginas hace muchos años.

Ella siempre insistía en que sus nietos hablaran español en casa, aunque viviéramos muy lejos de Sevilla.

Ahora yo quiero que mis hijos también hablen con ella y que coman en su casa los domingos.

Si hubiera sabido lo que decía la carta, habría respondido mucho antes.

Mi abuela pedía solamente que, antes de que terminara el verano, fuésemos a visitarla una vez más.

Aunque no lo dijo nunca, sé que nos echaba de menos.

Me gustaba su cante por las mañanas, aunque no entendiera la letra.

Que descanse en paz.
```

## What should highlight

| Form | Where | Covers |
|---|---|---|
| `abriera` | quería que la **abriera** | imperfect subj., `-ra` |
| `estuviera` | cuando **estuviera** solo | `cuando` + subjunctive |
| `haya escrito` | Es posible que **haya escrito** | present perfect subj. — **auxiliary must be included** |
| `hablaran` | insistía en que **hablaran** | imperfect subj., regular `-ar` |
| `viviéramos` | aunque **viviéramos** lejos | `aunque` + subjunctive |
| `hablen` | quiero que **hablen** | present subj., regular `-ar` |
| `coman` | y que **coman** | present subj., regular `-er` |
| `hubiera sabido` | Si **hubiera sabido** | pluperfect subj. |
| `terminara` | antes de que **terminara** | imperfect subj. after a subordinator |
| `fuésemos` | que … **fuésemos** a visitarla | imperfect subj., **`-se` form** |
| `entendiera` | aunque no **entendiera** | `aunque` + subjunctive, second instance |
| `No me digas` | dialogue line | negative imperative — **verb only, no trigger** |
| `descanse` | Que **descanse** en paz | independent subjunctive — **verb only, no trigger** |

Triggers that should pick up the muted tint of the same hue: *quería que*,
*cuando* (the second one), *Es posible que*, *insistía en que*, *aunque* (both
subjunctive instances), *quiero que*, *antes de que*.

## What must NOT highlight

These are the false-positive tests. Anything tinted here is a bug worth fixing
before trusting the feature:

| Decoy | Why it's a trap |
|---|---|
| `Cuando llegué a casa` | `cuando` + **indicative**. The doc's highest-risk case — the same trigger word is tagged three lines later. |
| `Aunque no lo dijo nunca` | `aunque` + **indicative**, directly contradicting the two `aunque` + subjunctive instances above it. |
| `que no tienes curiosidad` | `que` + indicative. Tests that `que` alone isn't treated as a trigger. |
| `su cante por las mañanas` | Noun (flamenco singing), homograph of the present subjunctive of *cantar*. The spec's omit-when-uncertain rule should catch it. |
| `habría respondido` | Conditional, sitting right next to a real pluperfect subjunctive in the same sentence. |
| `preferí`, `leería`, `dijo`, `sé`, `echaba` | Ordinary indicative/conditional forms. |

## Also worth checking while you're in there

- **The long sentence** (*Mi abuela pedía solamente que, antes de que terminara
  el verano, fuésemos a visitarla*) is over 15 words, so it will split across
  chunks. Expect `pedía … que` and `fuésemos` to land in **different chunks** —
  v1 does no cross-chunk pairing, so `fuésemos` should appear as a solo verb
  rather than paired. That's correct behaviour, not a miss.
- **`y que coman`** — one `quiero que` licensing two verbs. Whether the model
  shares a `pairId` across *hablen* and *coman* or treats the second `que` as
  its own trigger, both render sensibly; worth a look to see which it picked.
- **Tap a highlighted word on the phone.** The tint is className-only with no
  geometry change, but this is the claim most worth trying to break.
- **Toggle it off** in Settings → Appearance and re-read a chunk. It doubles as
  the self-test the spec wanted: can you spot the forms unaided?
