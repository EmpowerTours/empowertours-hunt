# Contribuir / Contributing

**Español abajo en cada sección. English follows in each section.**

---

## Lo más importante / The one rule that matters

**Tú haces tu propio commit, con tu propio nombre.**

No nos mandes tu trabajo por WhatsApp para que alguien más lo suba. El nombre en
el commit es la prueba de que participaste — si otra persona lo sube, tu trabajo
existe pero tú no. No importa si es una línea de traducción o una prueba en tu
teléfono: súbelo tú.

**You make your own commit, under your own name.**

Don't send us your work over WhatsApp for somebody else to commit. The author
field on a commit is the evidence that you took part — if someone else commits
it, your work exists but you don't. It does not matter whether it is one line of
translation or a test you ran on your phone: commit it yourself.

---

## No necesitas saber programar / You don't need to be a developer

Traducciones, correcciones al README, reportes de pruebas — todo cuenta igual.
La mayoría de las tareas de abajo se hacen **desde el teléfono, sin instalar
nada**.

Translated copy, README edits, test logs — all count fully. Most of the tasks
below can be done **from a phone with nothing installed**.

### Desde el teléfono, sin instalar nada / From your phone, nothing installed

1. Crea una cuenta en [github.com](https://github.com) (gratis).
2. Abre el archivo que quieras cambiar en este repositorio.
3. Toca el lápiz ✏️ para editarlo.
4. Escribe tu cambio.
5. Abajo, escribe una línea diciendo qué hiciste y toca **Commit changes**.

Eso es todo. Ya contribuiste, y tu nombre queda en la historia del proyecto.

1. Make a free account at [github.com](https://github.com).
2. Open the file you want to change in this repository.
3. Tap the pencil ✏️ to edit it.
4. Make your change.
5. At the bottom, write one line saying what you did and tap **Commit changes**.

That's it. You've contributed, and your name is in the project's history.

---

## Tareas reales que puedes tomar hoy / Real tasks you can take today

Toma una, dinos en el Telegram cuál tomaste para que nadie la repita, y súbela.

Take one, say in Telegram which one you took so nobody duplicates it, and commit it.

### 1. Traducir la app al español / Translate the app to Spanish

La app está en inglés en varios lugares. Los mensajes que ve un jugador cuando
algo falla son los más importantes — alguien los va a leer parado en la calle,
sin nadie a quién preguntarle.

Several parts of the app are still in English. The messages a player sees when
something goes wrong matter most — somebody reads those standing outdoors with
nobody to ask.

### 2. Probar en tu teléfono y reportar / Test on your phone and report

Abre la app, intenta usarla, y escribe qué pasó: qué teléfono, qué navegador,
qué botón tocaste, qué esperabas y qué viste. Un reporte de algo que **no**
falló también sirve — necesitamos saber en qué teléfonos funciona.

Open the app, try to use it, and write down what happened: which phone, which
browser, which button, what you expected, what you got. A report that something
**worked** is also useful — we need to know which phones are fine.

### 3. Proponer lugares para el hunt / Suggest hunt locations

¿Conoces un lugar en Tierra Colorada donde tenga sentido esconder algo? Un
parque, una tienda, una cancha. Necesitamos el nombre del lugar y por qué es
buena idea — seguro para caminar, se puede llegar sin coche.

Know a spot in Tierra Colorada where hiding something makes sense? A park, a
shop, a court. We need the place and why it's a good one — safe to walk to,
reachable without a car.

### 4. Arreglar el README / Fix the README

Si leíste el README y algo no se entendió, esa confusión es un bug. Arréglalo
con tus palabras.

If you read the README and something didn't make sense, that confusion is a bug.
Fix it in your own words.

---

## Para desarrolladores / For developers

```bash
npm install
npx vitest run        # tests
npx tsc --noEmit      # typecheck
```

Ambos deben pasar antes de subir. / Both must pass before you commit.

Comprobar cómo va el historial del equipo:
Check how the team's history is looking:

```bash
node scripts/community-check.mjs
```

Falla a propósito cuando el historial parece de una sola persona. No es un
reporte, es una compuerta.

It fails on purpose when the history reads as one person. It's a gate, not a
report.

---

## Preguntas / Questions

Telegram: [t.me/empowertourschat](https://t.me/empowertourschat)

Si no sabes por dónde empezar, pregunta ahí y te asignamos algo concreto.
If you don't know where to start, ask there and we'll give you something specific.
