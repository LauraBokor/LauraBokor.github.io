# Legrand Partner Klub – hűségprogram automatizálás

Cél: a Forminatorból (legrandpartnerklub.hu) érkező számla-feltöltéseket és
regisztrációkat automatikusan feldolgozni, a Legrand-termékek értékét
kiolvasni a feltöltött számlákból, az ajándék-szintet meghatározni, és
hetente egy email-összefoglalót küldeni. Cél volt: **ingyenes**, **a saját
Google-fiókod alatt fut**, **nem kell új WordPress plugin vagy fizetős
no-code eszköz**.

## Hogyan működik

```
Forminator (WordPress)
   │  heti CSV export (kézzel, ahogy most is csinálod)
   ▼
Google Drive "Beérkező exportok" mappa
   │  feltöltöd a 2 CSV-t (számlák, regisztrációk) ide
   ▼
Google Apps Script – 2 óránként lefut
   │  1) beolvassa az új CSV sorokat a Sheetbe (dedupolva)
   │  2) minden még fel nem dolgozott számlához:
   │       - letölti a feltöltött PDF/fotó(ka)t a publikus URL-ről
   │       - Gemini AI-val kiolvassa a tételeket
   │       - párosítja az árlistával -> Legrand-érték
   │       - összeveti a feltöltő saját bevallásával -> eltérésnél jelöli
   │       - meghatározza az ajándék-szintet
   ▼
Google Sheet ("Feldolgozott_Szamlak" fül) – ez a te munkalapod,
a gyakornok csak a "kezi_ellenorzes_szukseges = TRUE" sorokat nézi át
   │
   ▼
Heti trigger (hétfő 8:00) – összesítő email neked
```

**Fontos, őszinte korlát:** a beérkező számlák nagyon vegyesek (kézzel írt,
elforgatott telefonfotó, sokféle viszonteladói formátum). A rendszer nem
100%-ban pontos – ez nem is reális elvárás egyetlen automatizált
megoldástól sem. A cél nem az, hogy a gyakornok munkáját feleslegessé
tegye, hanem hogy **a triviális eseteket (tiszta PDF, egyértelmű Legrand
tételek) automatikusan elintézze, és csak a bizonytalan/eltérő eseteket
(kb. a számlák egy kisebb hányadát) jelölje ki neki átnézésre** – ezt jelzi
a `kezi_ellenorzes_szukseges` oszlop és annak oka.

## Költség

- Google Sheets, Apps Script, Drive, Gmail küldés: **ingyenes** (a te
  személyes/Workspace Google-fiókod kvótáján belül marad ennél a
  mennyiségnél).
- Számlaolvasás: **Gemini 2.0 Flash**, Google AI Studio ingyenes kulcs
  (https://aistudio.google.com/app/apikey). Az ingyenes kvóta jelenleg bőven
  elég heti 50-150 számlához. Ha egyszer túllépnéd, az árazás akkor is
  töredék centekben mérhető számlánként – nem fog számottevő költséget
  jelenteni.
- Nincs havidíjas előfizetés, nincs Zapier/Make.

## Adatbiztonság

- Minden adat a te saját Google-fiókodban marad (Sheet, Drive), nincs
  harmadik fél SaaS-nak átadott tárolás.
- A számla *tartalma* (kép/PDF) egyetlen célból megy ki: a Google Gemini
  API-nak, feldolgozásra (kiolvasás), API-hívásonként. Ezek üzleti számlák
  (viszonteladó neve, tételek, összeg) – nem különleges személyes adat, de
  ha szeretnéd, ezt a lépést lecserélheted más motorra (lásd lent).
- A Gemini API kulcsot **Script Properties**-ben tároljuk (nem a Sheetben,
  nem a kódban) – ez a Google Apps Script beépített, biztonságos
  kulcstárolója, amit csak a scriptet futtató fiók tud olvasni.
- Oszd meg a Sheetet és a Drive mappákat kizárólag a szükséges emberekkel
  (te + esetleg a gyakornok, "szerkesztő" jogosultsággal, NE "bárki, aki
  rendelkezik a linkkel").

## Telepítés

1. **Hozz létre egy új Google Sheetet** (pl. "Legrand Hűségprogram –
   automatizálás").
2. **Extensions > Apps Script**, illeszd be a `Code.gs` tartalmát (töröld
   ki az alap `myFunction()`-t), és az `appsscript.json`-t is (Project
   Settings > "Show appsscript.json" bekapcsolása után).
3. **Importáld az árlistát**: a Sheetben `File > Import > Upload`, töltsd
   fel a `pricelist/legrand_pricelist_2026-03-18.csv` fájlt, "Insert new
   sheet" módban, majd nevezd át a létrejött fület pontosan `Arlista`-ra.
   (Amikor Legrand új árlistát ad ki, ezt a lépést ismételd meg – cseréld
   le a fül tartalmát az új CSV-vel.)
4. **Hozz létre két Drive mappát**: "Legrand – beérkező exportok" és
   "Legrand – archívum". Másold ki mindkettő ID-ját az URL-jükből
   (`drive.google.com/drive/folders/<EZ_AZ_ID>`).
5. Az Apps Script szerkesztőben: **Project Settings (fogaskerék ikon) >
   Script Properties**, add hozzá:
   - `DRIVE_INBOX_FOLDER_ID` = a beérkező mappa ID-ja
   - `DRIVE_ARCHIVE_FOLDER_ID` = az archívum mappa ID-ja
   - `GEMINI_API_KEY` = a Google AI Studio-ból kapott kulcs
   - `REPORT_EMAILS` = a te email címed (vesszővel több is megadható)
6. A szerkesztőben futtasd egyszer a **`setupSheets`** függvényt (a
   legördülőből válaszd ki, majd Run). Első futáskor a Google engedélyt
   fog kérni – ez normális, mivel a script Sheetet, Drive-ot és emailt
   fog kezelni a te nevedben.
7. Futtasd egyszer a **`createTriggers`** függvényt – ez beállítja a
   2 óránkénti feldolgozást és a hétfő reggeli összefoglalót.
8. **Heti rutin**: a Forminatorból exportált 2 CSV-t (számlák,
   regisztrációk) töltsd fel a "beérkező exportok" Drive mappába. A
   fájlnévben szerepeljen a `szamla` vagy a `regisztr` szó (pl.
   `szamlak_2026-07-20.csv`, `regisztraciok_2026-07-20.csv`), hogy a
   script tudja szétválogatni őket.

## Amit még véglegesíteni kell veled

1. **A regisztrációs export oszlopnevei** – ezt még nem küldted el. A
   `Code.gs`-ben az `importRegistrationRows_` függvény most rugalmasan
   próbálja megtalálni az idő/név/email oszlopokat, de amint megkapom a
   valós exportot, pontosítom.
2. **Az ajándék-szintek "felett" szabálya** – jelenleg szigorú `>` relációt
   feltételezek (pl. pontosan 400.000 Ft NEM elég a 400k-s szinthez).
   Erősítsd meg, hogy ez helyes-e.
3. **Az árrés/döntési logika finomhangolása** – a `REVIEW_DISCREPANCY_RATIO`
   (jelenleg 15%) és a szófelismerés-alapú párosítás (`bestFuzzyMatch_`,
   0.5-ös küszöb) valós adatokon fog kiderülni, hogy jól van-e hangolva.
   Javaslom, hogy az első 2-3 hétben a gyakornok minden számlát nézzen át
   is, és hasonlítsátok össze az AI eredményével – ebből látszik, hol kell
   szigorítani/lazítani.
4. Ha a Gemini pontossága nem lenne elég jó a kézzel írt/rossz minőségű
   fotóknál, alternatíva: ugyanez a kódváz átírható a Claude API-ra
   (jobb lehet vegyes/kézzel írt számláknál, de nem ingyenes – kb.
   néhány forint/számla ennél a mennyiségnél).

## Fájlok

- `Code.gs` – a teljes Apps Script logika.
- `appsscript.json` – Apps Script projekt manifest.
- `pricelist/legrand_pricelist_2026-03-18.csv` – a feltöltött árlistából
  kinyert, kompakt formátum (cikkszám, SAP rendelési szám, megnevezés,
  listaár, státusz), amit az `Arlista` fülre kell importálni.
