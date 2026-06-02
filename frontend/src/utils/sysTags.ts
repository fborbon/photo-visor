export const GEO_CONTINENTS = new Set([
  'Asia', 'Africa', 'Europa', 'Oceania', 'America',
  'Suramerica', 'Norteamerica', 'Centroamerica',
]);

export const COUNTRY_ALIASES: Record<string, string> = {
  'canadá':    'Canada',
  'canada':    'Canada',
  'yugoslavia':'Croatia',
};

export const CITY_ALIASES: Record<string, string> = {
  'logrono':              'Logroño',
  'londres':              'London',               // normalize folder spelling
  'rio urederra':         'Urederra',             // merge Rio Urederra with Urederra → 4-pin circle
  'alaiz aerial view':    'Alaiz',                // merge Alaiz sub-albums → circle-spread
  'alaiz desde carretera':'Alaiz',
  'alaiz visita newa':    'Alaiz',
  'nacionalidad':         'Madrid',              // nationality ceremony is in Madrid
  'polideportivo cartago':'Cinco pinos de Cartago', // same Cartago area
  'brussells':            'Bruselas',            // typo of Brussels
  'bruges':               'Brugge',              // Flemish/English → canonical
  'vitoria-gasteiz':      'Vitoria',             // same city, alternate name
  'milan':                'Milano',              // same city, alternate spelling
};

export function normalizeCountry(raw: string): string {
  return COUNTRY_ALIASES[raw.toLowerCase()] ?? raw;
}

export function leadingCity(segment: string): string {
  const d = segment.indexOf(' - ');
  const s = segment.indexOf('/');
  const ends = [d, s].filter(i => i > 0);
  const raw = ends.length ? segment.slice(0, Math.min(...ends)) : segment;
  const stripped = raw.replace(/ \d+$/, '').trim();
  return CITY_ALIASES[stripped.toLowerCase()] ?? stripped;
}

export function sysTagCountryKey(name: string): string {
  const slashIdx = name.indexOf('/');
  const firstSeg = slashIdx > 0 ? name.slice(0, slashIdx) : name;
  if (GEO_CONTINENTS.has(firstSeg) && slashIdx > 0) {
    const rest = name.slice(slashIdx + 1);
    const secondSeg = rest.indexOf('/') > 0 ? rest.slice(0, rest.indexOf('/')) : rest;
    const dashIdx = secondSeg.indexOf(' - ');
    const raw = dashIdx > 0 ? secondSeg.slice(0, dashIdx) : secondSeg;
    return normalizeCountry(raw);
  }
  const dashIdx = firstSeg.indexOf(' - ');
  const raw = dashIdx > 0 ? firstSeg.slice(0, dashIdx) : firstSeg;
  return normalizeCountry(raw);
}

export function sysTagCityKey(name: string): string {
  const slashIdx = name.indexOf('/');
  if (slashIdx < 0) {
    const d = name.indexOf(' - ');
    return d > 0 ? name.slice(d + 3) : '';
  }
  const firstSeg = name.slice(0, slashIdx);
  const rest = name.slice(slashIdx + 1);
  if (GEO_CONTINENTS.has(firstSeg)) {
    const nextSlash = rest.indexOf('/');
    const secondSeg = nextSlash > 0 ? rest.slice(0, nextSlash) : rest;
    const d = secondSeg.indexOf(' - ');
    if (d > 0) return leadingCity(secondSeg.slice(d + 3));
    if (nextSlash > 0) return leadingCity(rest.slice(nextSlash + 1));
    return '';
  }
  return leadingCity(rest);
}

export function sysTagLabel(name: string): string {
  const idx = name.indexOf('/');
  return idx > 0 ? name.slice(idx + 1) : name;
}

// ── Coordinates lookup ────────────────────────────────────────────────────
// Keys: "CanonicalCountry:CanonicalCity" (matching sysTagCountryKey / sysTagCityKey output).
// Keys with empty city ("Country:") serve as country-capital fallback.
// Coverage verified against actual system tags in this collection.
const SYS_TAG_COORDS: Record<string, [number, number]> = {

  // ── Alemania (Germany) ────────────────────────────────────────────────
  'Alemania:':           [ 52.5200,   13.4050],  // Berlin (capital fallback)
  'Alemania:Berlin':     [ 52.5200,   13.4050],
  'Alemania:Berlín':     [ 52.5200,   13.4050],
  'Alemania:Dusseldorf': [ 51.2217,    6.7762],
  'Alemania:Düsseldorf': [ 51.2217,    6.7762],
  'Alemania:Frankfurt':          [ 50.1109,    8.6821],
  'Alemania:Frankfurt airport':  [ 50.0379,    8.5622],  // Frankfurt Airport
  'Alemania:Hamburg':    [ 53.5753,   10.0153],
  'Alemania:Hamburgo':   [ 53.5753,   10.0153],
  'Alemania:Kassel':     [ 51.3127,    9.4797],
  'Alemania:Köln':       [ 50.9333,    6.9500],
  'Alemania:Colonia':    [ 50.9333,    6.9500],
  'Alemania:Munich':     [ 48.1351,   11.5820],
  'Alemania:Múnich':     [ 48.1351,   11.5820],
  'Alemania:Braunschweig': [ 52.2689,  10.5268],
  'Alemania:Toulouse':   [ 43.6047,    1.4442],  // Toulouse trip via Sarah's .Amigos album
  'Alemania:Dortmund':   [ 51.5136,    7.4653],
  'Alemania:Stuttgart':  [ 48.7758,    9.1829],
  'Alemania:Vallendar':  [ 50.4028,    7.6053],  // small city in Rhineland-Palatinate

  // ── Austria ───────────────────────────────────────────────────────────
  'Austria:':            [ 48.2082,   16.3738],  // Vienna (capital fallback)
  'Austria:Viena':       [ 48.2082,   16.3738],

  // ── Andorra ───────────────────────────────────────────────────────────
  'Andorra:':            [ 42.5063,    1.5218],  // Andorra la Vella (capital fallback)
  'Andorra:Girona':      [ 41.9794,    2.8214],  // Girona, Spain (tag covers both)

  // ── Argentina ─────────────────────────────────────────────────────────
  'Argentina:':          [-34.6037,  -58.3816],  // Buenos Aires (capital fallback)
  'Argentina:Buenos Aires': [-34.6037, -58.3816],
  'Argentina:Bariloche': [-41.1335,  -71.3103],
  'Argentina:Campana':   [-34.1657,  -58.9586],  // industrial city, Buenos Aires province
  'Argentina:Córdoba':   [-31.4201,  -64.1888],
  'Argentina:Mar del Plata': [-37.9995, -57.5558],
  'Argentina:Mendoza':   [-32.8908,  -68.8272],
  'Argentina:Rosario':   [-32.9442,  -60.6505],
  'Argentina:Salta':     [-24.7859,  -65.4116],
  'Argentina:Tucumán':   [-26.8083,  -65.2176],
  'Argentina:Ushuaia':   [-54.8019,  -68.3030],

  // ── Asia (continent prefix tags) ──────────────────────────────────────
  'Australia:Sydney':    [-33.8688,  151.2093],
  'Israel:Jerusalem':    [ 31.7683,   35.2137],
  'Israel:Jerusalén':    [ 31.7683,   35.2137],
  'Israel:Tel Aviv':     [ 32.0853,   34.7818],
  'Japón:Tokyo':         [ 35.6762,  139.6503],
  'Japón:Tokio':         [ 35.6762,  139.6503],
  'Tailandia:Bangkok':   [ 13.7563,  100.5018],
  'Tailandia:Bankok':    [ 13.7563,  100.5018],  // common misspelling in tags
  'UAE:Dubai':           [ 25.2048,   55.2708],
  'Emiratos Árabes Unidos:Dubai': [25.2048, 55.2708],
  'Emiratos Árabes:Dubai': [25.2048, 55.2708],

  // ── Belgica (Belgium) ─────────────────────────────────────────────────
  'Belgica:':            [ 50.8503,    4.3517],  // Brussels (capital fallback)
  'Bélgica:':            [ 50.8503,    4.3517],
  'Belgica:Antwerpen':   [ 51.2194,    4.4025],  // Antwerp
  'Belgica:Bruselas':    [ 50.8503,    4.3517],
  'Bélgica:Bruselas':    [ 50.8503,    4.3517],
  'Belgica:Liege':       [ 50.6326,    5.5797],  // Liège
  'Belgica:Brujas':      [ 51.2093,    3.2247],  // Bruges
  'Bélgica:Brujas':      [ 51.2093,    3.2247],
  'Belgica:Brugge':      [ 51.2093,    3.2247],  // Bruges (folder spelling in Visitas)
  'Belgica:Brussells':   [ 50.8503,    4.3517],  // Brussels (folder spelling in Visitas)

  // ── Brasil (Brazil) ───────────────────────────────────────────────────
  'Brasil:':             [-15.7801,  -47.9292],  // Brasília (capital fallback)
  'Brasil:Belo Horizonte': [-19.9167, -43.9345],
  'Brasil:Florianópolis': [-27.5954,  -48.5480],
  'Brasil:Fortaleza':    [  -3.7172,  -38.5433],
  'Brasil:Maceió':       [  -9.6658,  -35.7350],
  'Brasil:Recife':       [  -8.0476,  -34.8770],
  'Brasil:Rio de Janeiro': [-22.9068, -43.1729],
  'Brasil:São Paulo':    [-23.5505,  -46.6333],
  'Brasil:Sao Pablo':   [-23.5505,  -46.6333],  // folder spelling used in .Amigos
  'Brasil:Salvador':     [-12.9714,  -38.5014],

  // ── Bolivia ───────────────────────────────────────────────────────────
  'Bolivia:':            [-16.4897,  -68.1193],  // La Paz (seat of government)
  'Bolivia:La Paz':      [-16.4897,  -68.1193],

  // ── Canada ────────────────────────────────────────────────────────────
  'Canada:':             [ 45.4215,  -75.6972],  // Ottawa (capital fallback)
  'Canada:Calgary':      [ 51.0447, -114.0719],
  'Canada:Magog':        [ 45.3667,  -72.1440],  // Magog, Quebec
  'Canada:Montreal':     [ 45.5017,  -73.5673],
  'Canada:Niagara Falls': [43.0962,  -79.0377],
  'Canada:Ottawa':       [ 45.4215,  -75.6972],
  'Canada:Quebec':       [ 46.8139,  -71.2080],
  'Canada:Toronto':      [ 43.6532,  -79.3832],
  'Canada:Vancouver':    [ 49.2827, -123.1207],

  // ── Chile ─────────────────────────────────────────────────────────────
  'Chile:':              [-33.4489,  -70.6693],  // Santiago (capital fallback)
  'Chile:Santiago':      [-33.4489,  -70.6693],
  'Chile:Valparaíso':    [-33.0472,  -71.6127],
  'Chile:Viña del Mar':  [-33.0247,  -71.5518],

  // ── Colombia ──────────────────────────────────────────────────────────
  'Colombia:':           [  4.7110,  -74.0721],  // Bogotá (capital fallback)
  'Colombia:Bogotá':     [  4.7110,  -74.0721],
  'Colombia:Cartagena':  [ 10.3910,  -75.4794],
  'Colombia:Medellín':   [  6.2442,  -75.5812],

  // ── Costa Rica ───────────────────────────────────────────────────────
  // Many tags are family/personal albums without city info → fallback San José
  'Costa Rica:':                    [  9.9281,  -84.0907],  // San José (capital fallback)
  // Voluntariados
  'Costa Rica:Cabo Blanco':         [  9.5875,  -85.0929],  // Reserva Natural Cabo Blanco, SW Nicoya
  'Costa Rica:Cerro Chirripó':      [  9.4844,  -83.4904],  // highest peak in CR, Chirripó NP
  'Costa Rica:Playa Grande':        [ 10.3197,  -85.8518],  // Playa Grande, Guanacaste (leatherback nesting)
  'Costa Rica:Playa Manuel Antonio': [ 9.3882,  -84.1627],  // Manuel Antonio NP, Quepos
  'Costa Rica:Tortuguero':          [ 10.5369,  -83.5007],  // Tortuguero village, Caribbean coast
  // Paseos en automovil
  'Costa Rica:Atirro':              [  9.8500,  -83.5500],  // Atirro, Turrialba canton, Cartago
  'Costa Rica:Cahuita':             [  9.7414,  -82.8399],  // Cahuita National Park, Caribbean coast
  'Costa Rica:Jardin Lankester':    [  9.8758,  -83.8952],  // Jardín Botánico Lankester, Paraíso, Cartago
  'Costa Rica:Juan Viñas de Turrialba': [ 9.9093, -83.7452], // Juan Viñas, Jiménez canton, Cartago
  'Costa Rica:Los Chiles':          [ 11.0280,  -84.7147],  // Los Chiles canton, Alajuela (near Nicaragua)
  'Costa Rica:Perez Zeledon':       [  9.3708,  -83.6874],  // San Isidro del General, Pérez Zeledón
  'Costa Rica:Rio Celeste':         [ 10.6986,  -85.0256],  // Río Celeste, Tenorio Volcano NP
  'Costa Rica:Rosas de Llano Grande': [ 9.8770, -83.9380],  // Rosas, Llano Grande, Cartago
  'Costa Rica:Sarapiquí':           [ 10.4338,  -84.0000],  // Puerto Viejo de Sarapiquí, Heredia
  'Costa Rica:Sarchí':              [ 10.1006,  -84.3786],  // Sarchí, Alajuela (artisan crafts town)
  'Costa Rica:Turrialba':           [  9.9007,  -83.6816],  // Turrialba city, Cartago
  'Costa Rica:Tuis':                [  9.8803,  -83.7303],  // Tuis community, Jiménez canton, Cartago
  'Costa Rica:Volcán Barva':        [ 10.1344,  -84.0992],  // Barva Volcano, Braulio Carrillo NP
  'Costa Rica:Zarcero':             [ 10.1784,  -84.3983],  // Zarcero, Alajuela (topiary park)
  // Paseos en bicicleta
  'Costa Rica:Cinco pinos de Cartago': [ 9.8630, -83.9199],  // Cinco Pinos, Cartago area
  'Costa Rica:Copalchí':            [  9.9168,  -83.8816],  // Copalchí, Oreamuno canton, Cartago
  'Costa Rica:Escazú':              [  9.9154,  -84.1402],  // Escazú canton, San José metro
  'Costa Rica:Llano Grande':        [  9.8770,  -83.9340],  // Llano Grande, Cartago
  'Costa Rica:Parque de la paz':    [  9.9562,  -84.0831],  // Parque de la Paz, San José
  'Costa Rica:Polideportivo Cartago': [ 9.8630, -83.9199],  // Polideportivo de Cartago city
  'Costa Rica:Sanatorio Durán':     [  9.9157,  -83.8821],  // Sanatorio Durán, Irazú volcano slope
  'Costa Rica:San Lorenzo de Flores': [ 9.9968, -84.0927],  // San Lorenzo, Flores canton, Heredia
  'Costa Rica:San Luis de Heredia': [ 10.0013,  -84.1218],  // San Luis, Heredia canton
  'Costa Rica:San Rafael de Heredia': [10.0187, -84.0906],  // San Rafael canton, Heredia
  'Costa Rica:Santa Clara de Cartago': [ 9.8660, -83.9970], // Santa Clara, La Unión, Cartago
  'Costa Rica:Tucurrique':          [  9.8803,  -83.7303],  // Tucurrique, Jiménez canton, Cartago
  'Costa Rica:Turrialba-Lago Piri-5 Pinos': [ 9.9007, -83.6816], // Lago Piri area near Turrialba
  // Family / personal (no specific city)
  'Costa Rica:Colima':              [  9.9501,  -84.0730],  // Colima district, near San José
  'Costa Rica:Mastatal':            [  9.6167,  -84.5500],  // small village, Puriscal canton
  'Costa Rica:Tibás':               [  9.9584,  -84.0786],  // Tibás canton, north of San José
  'Costa Rica:UCR':                 [  9.9355,  -84.0509],  // Universidad de Costa Rica, San Pedro

  // ── Cuba ──────────────────────────────────────────────────────────────
  'Cuba:':               [ 23.1136,  -82.3666],  // Havana (capital fallback)
  'Cuba:La Habana':      [ 23.1136,  -82.3666],

  // ── Croatia ───────────────────────────────────────────────────────────
  'Croatia:':            [ 45.8150,   15.9819],  // Zagreb (capital fallback)
  'Croatia:Dubrovnik':   [ 42.6507,   18.0944],
  'Croatia:Zagreb':      [ 45.8150,   15.9819],

  // ── Dinamarca (Denmark) ───────────────────────────────────────────────
  'Dinamarca:':          [ 55.6761,   12.5683],  // Copenhagen (capital fallback)
  'Dinamarca:Copenhagen': [55.6761,   12.5683],
  'Dinamarca:Copenhaguen': [55.6761,  12.5683],
  'Dinamarca:Copenhague': [55.6761,   12.5683],
  'Dinamarca:Høvsøre':                        [ 56.4437,  8.1478],  // Høvsøre, west Jutland
  'Dinamarca:Høvsøre Wind Turbine Test Center': [ 56.4437,  8.1478],  // full folder name variant
  'Dinamarca:Legoland':  [ 55.7359,    9.1268],  // Legoland Billund
  'Dinamarca:Riso':      [ 55.6916,   12.0996],  // Risø DTU, Roskilde
  'Dinamarca:Riso DTU':  [ 55.6916,   12.0996],  // Risø DTU, Roskilde (full name variant)

  // ── Egipto (Egypt) ────────────────────────────────────────────────────
  'Egipto:':             [ 30.0444,   31.2357],  // Cairo (capital fallback)
  'Egipto:El Cairo':     [ 30.0444,   31.2357],
  'Egipto:Cairo':        [ 30.0444,   31.2357],
  'Egipto:Alejandría':   [ 31.2001,   29.9187],
  'Egipto:Luxor':        [ 25.6872,   32.6396],
  'Egipto:Sharm El Sheikh': [27.9158, 34.3300],
  'Egipto:Sharm el Sheikh': [27.9158, 34.3300],

  // ── Eslovaquia (Slovakia) ─────────────────────────────────────────────
  'Eslovaquia:':         [ 48.1485,   17.1077],  // Bratislava (capital fallback)
  'Eslovaquia:Bratislavia': [ 48.1485, 17.1077], // folder spelling in Visitas

  // ── España (Spain) ────────────────────────────────────────────────────
  'España:':             [ 40.4168,   -3.7038],  // Madrid (capital fallback)
  'España:Albarracin':   [ 40.4092,   -1.4380],  // medieval walled town, Teruel
  'España:Andalucia':    [ 37.5443,   -4.7278],  // Andalusia region centroid
  'España:Andorra':      [ 42.5063,    1.5218],  // trip to Andorra from Spain
  'España:Anguiano y Atapuerca': [42.3030, -3.1640], // La Rioja + Burgos area
  'España:Asturias':     [ 43.3614,   -5.8593],  // Oviedo (regional capital)
  'España:Astun':        [ 42.8010,   -0.5510],  // ski resort, Huesca Pyrenees
  'España:Barcelona':    [ 41.3851,    2.1734],
  'España:Bilbao':       [ 43.2627,   -2.9253],
  'España:Burgos':       [ 42.3440,   -3.6969],
  'España:Candachú':     [ 42.7984,   -0.5271],  // ski resort, Huesca Pyrenees
  'España:Canet de Berenguer': [39.6797, -0.2215], // coastal town, Valencia
  'España:Cabárceno':    [ 43.3922,   -3.8028],  // Parque de la Naturaleza, Cantabria
  'España:Castro Urdiales': [43.3830,  -3.2189],  // coastal town, Cantabria
  'España:Cataluña':     [ 41.5912,    1.5209],  // Catalonia region centroid
  'España:Cadaques':     [ 42.2882,    3.2803],  // Cadaqués, Costa Brava
  'España:Cadaqués':     [ 42.2882,    3.2803],
  'España:Figueres':     [ 42.2669,    2.9608],  // Figueres, Alt Empordà
  'España:Girona':       [ 41.9794,    2.8214],
  'España:Malgrat de Mar': [41.6474,   2.7461],  // Malgrat de Mar, Maresme coast
  'España:Ribes de Freser': [42.3073,  2.1702],  // Ribes de Freser, Ripollès
  'España:Roses':        [ 42.2669,    3.1779],  // Roses, Costa Brava
  'España:Sabadell':     [ 41.5436,    2.1095],  // Sabadell, Vallès Occidental
  'España:Sant Cugat de Valles': [41.4722, 2.0844], // Sant Cugat del Vallès
  'España:Cogumelo':     [ 43.2627,   -2.9253],  // Bilbao area
  'España:Cáceres':      [ 39.4753,   -6.3724],
  'España:Córdoba':      [ 37.8882,   -4.7794],
  'España:Donostia':     [ 43.3183,   -1.9812],  // Basque name for San Sebastián
  'España:Durango':      [ 43.2175,   -2.6332],  // Basque Country
  'España:Estella':      [ 42.6706,   -2.0319],  // Estella-Lizarra, Navarra
  'España:Ferrol':       [ 43.4843,   -8.2328],  // Ferrol, Galicia
  'España:Formigal':     [ 42.7722,   -0.3803],  // ski resort, Huesca Pyrenees
  'España:Gastelugatxe': [ 43.4393,   -2.7739],  // iconic islet near Bermeo
  'España:Gran Canaria': [ 27.9202,  -15.5474],  // Las Palmas
  'España:Granada':      [ 37.1773,   -3.5986],
  'España:Guernica':     [ 43.3163,   -2.6787],  // Gernika-Lumo, Basque Country
  'España:Guillen':      [ 43.2627,   -2.9253],  // Bilbao area
  'España:Hernani':      [ 43.2688,   -1.9759],  // Gipuzkoa, near San Sebastián
  'España:Hondarribia':  [ 43.3649,   -1.7975],  // Gipuzkoa, near French border
  'España:Igueldo':      [ 43.3169,   -2.0128],  // Monte Igueldo near San Sebastián
  'España:Javier':       [ 42.5893,   -1.2081],  // castle town, Navarra
  'España:La Rioja':     [ 42.4627,   -2.4449],  // → Logroño (regional capital)
  'España:Laudio':       [ 43.1442,   -2.9775],  // Laudio/Llodio, Basque Country
  'España:Levante':      [ 39.4699,   -0.3763],  // eastern Spain / Valencia region
  'España:Leyre':        [ 42.5953,   -1.0998],  // Monasterio de Leyre, Navarra
  'España:Logroño':      [ 42.4627,   -2.4449],
  'España:Lourdes':      [ 43.0956,   -0.0463],  // Lourdes (France) via Spain
  'España:Madrid':       [ 40.4168,   -3.7038],
  'España:Málaga':       [ 36.7213,   -4.4214],
  'España:Malaga':       [ 36.7213,   -4.4214],
  'España:Mallorca':     [ 39.6952,    3.0176],
  'España:Melide':       [ 42.9131,   -8.0150],  // Melide, Galicia (Camino de Santiago)
  'España:Mondragon':    [ 43.0637,   -2.4949],  // Mondragón/Arrasate, Gipuzkoa
  'España:Monte Irun':   [ 43.3360,   -1.7930],  // near Irun, Gipuzkoa
  'España:Alicante':     [ 38.3452,   -0.4810],
  'España:Almería':      [ 36.8340,   -2.4637],
  'España:Aranjuez':     [ 40.0322,   -3.6023],
  'España:Benidorm':     [ 38.5386,   -0.1317],
  'España:Bermeo':       [ 43.4197,   -2.7211],  // Basque fishing port
  'España:Bosque de Oma': [43.3572,   -2.7400],  // painted forest, Bizkaia
  'España:Cabo de Gata': [ 36.7285,   -2.0217],  // natural park, Almería coast
  'España:Cartagena':    [ 37.6074,   -0.9897],  // Murcia region
  'España:Castellón de la Plana': [39.9864, -0.0513],
  'España:Escaray':      [ 42.3217,   -3.0528],  // ski area, La Rioja
  'España:Gijon':        [ 43.5453,   -5.6616],  // Asturias
  'España:Guernika':     [ 43.3163,   -2.6787],  // Gernika-Lumo (alternate spelling)
  'España:Hondón de los Frailes': [38.2233, -0.9078],  // Alicante inland village
  'España:Huesca':       [ 42.1401,   -0.4089],
  'España:León':         [ 42.5987,   -5.5671],
  'España:Merida':       [ 38.9143,   -6.3477],  // Extremadura
  'España:Mundaka':      [ 43.4072,   -2.6961],  // surf town, Bizkaia
  'España:Murcia':       [ 37.9845,   -1.1285],
  'España:Nerja':        [ 36.7572,   -3.8709],  // Andalusia coast
  'España:Sabiñánigo':   [ 42.5219,   -0.3644],  // Huesca Pyrenees
  'España:Soria':        [ 41.7631,   -2.4647],
  'España:Nacionalidad': [ 40.4168,   -3.7038],  // nationality ceremony, Madrid
  'España:Navarra':      [ 42.8166,   -1.6434],  // → Pamplona (regional capital)
  'España:Aibar':        [ 42.5461,   -1.3906],  // town in Navarra
  'España:Alaiz':              [ 42.7167,   -1.6333],  // mountain/wind farm area near Pamplona
  'España:Alaiz aerial view':  [ 42.7167,   -1.6333],  // aerial photos of Alaiz wind farm
  'España:Alaiz desde carretera': [42.7167,  -1.6333],  // Alaiz from the road
  'España:Alaiz visita NEWA':  [ 42.7167,   -1.6333],  // NEWA project visit to Alaiz
  'España:Aoiz & Lumbier & Sanguesa': [42.7803, -1.3697], // Aoiz area, Navarra
  'España:Ardanaz':      [ 42.8053,   -1.4972],  // village near Pamplona
  'España:Arellano':     [ 42.5858,   -2.0236],  // village, southern Navarra
  'España:Arrete':       [ 42.9776,   -0.7449],  // La Pierre Saint-Martin ski area, Pyrenees (Navarra/France border)
  'España:Artajona':     [ 42.5974,   -1.7713],  // walled town, Navarra
  'España:Astigarraga':  [ 43.2697,   -1.9278],  // cider town, Gipuzkoa
  'España:Badostain':    [ 42.7988,   -1.5952],  // Badostáin, Navarre
  'España:Barañain':     [ 42.8153,   -1.6744],  // suburb of Pamplona
  'España:Bardenas Reales': [42.1833,  -1.5167], // desert natural park, Navarra
  'España:Berroeta':     [ 43.1040,   -1.5907],  // village, Navarra
  'España:Bosque Orgui': [ 42.9647,   -1.6799],  // Orgi Basoa forest, Navarra
  'España:Casa Baranain y estaciones del ano': [42.8153, -1.6744], // Barañain area
  'España:Briones':      [ 42.5339,   -2.8194],  // wine village, La Rioja
  'España:Burgui':       [ 42.7750,   -0.8981],  // Roncal valley, Navarra
  'España:Castillo Javier': [42.5893,  -1.2081], // castle, Navarra (Javier)
  'España:Cuevas de Zugaramundi': [43.2697, -1.5289],  // caves, Navarra/Basque border
  'España:Echauri':      [ 42.7944,   -1.7898],  // Etxauri/Echauri village, Navarre
  'España:Eguino':       [ 42.9167,   -2.0833],  // village, Navarra/Álava border
  'España:Elizondo':     [ 43.1414,   -1.5131],  // capital of Baztan valley
  'España:Etxauri':      [ 42.8010,   -1.8461],  // Ermita Santa Cruz, Etxauri, Navarre
  'España:Eugui':        [ 42.9972,   -1.5478],  // village and reservoir, Navarra
  'España:Foz de Arbayun': [42.6561,  -1.2733],  // gorge natural reserve, Navarra
  'España:Foz de Lumbier': [42.6533,  -1.3050],  // gorge near Lumbier, Navarra
  'España:Isaba':        [ 42.8622,   -0.9128],  // Roncal valley, Navarra
  'España:Lesaka':       [ 43.2564,   -1.7322],  // town, north Navarra
  'España:Mesa de los 3 reyes': [42.8800, -0.7450], // highest peak in Navarra
  'España:Milagro':      [ 42.2333,   -1.7833],  // town, Ribera Navarra
  'España:Monreal':      [ 42.7233,   -1.5153],  // village, Navarra
  'España:Monte El Perdon': [42.7547,  -1.7017],  // wind-farm hill near Pamplona
  'España:Ochagavia':    [ 42.9181,   -1.0772],  // Salazar valley, Navarra
  'España:Olite':        [ 42.4806,   -1.6511],  // castle town, Navarra
  'España:Parque Aralar': [43.0583,   -2.1167],  // natural park, Navarra/Gipuzkoa
  'España:Petilla de Aragon': [42.4556, -1.0800], // enclave village, Navarra
  'España:Puente de la Reina': [42.6722, -1.8111], // pilgrim town, Navarra
  'España:Puente La Reina': [42.6722,  -1.8111],  // same town, alternate folder name
  'España:Pueyo':        [ 42.5667,   -1.6475],  // Pueyo, Navarra
  'España:Ribadesella':  [ 43.4614,   -5.0606],  // coastal town, Asturias (Descenso del Sella)
  'España:Roncesvalles': [ 43.0092,   -1.3194],  // historic pass and monastery
  'España:San Fermin':   [ 42.8166,   -1.6434],  // San Fermín festival (Pamplona)
  'España:Sanguesa':     [ 42.5700,   -1.2817],  // town, eastern Navarra
  'España:Selva de Iriati': [42.9778,  -1.2000],  // Irati forest, Navarra
  'España:Senda Viva':   [ 42.3194,   -1.7278],  // nature park, Navarra
  'España:Sierra de Leire': [42.6667,  -1.1333],  // mountain range, Navarra
  'España:Tiermas':      [ 42.6028,   -1.0406],  // submerged village, Aragon/Navarra
  'España:Tudela':       [ 42.0600,   -1.6056],  // city, Ribera Navarra
  'España:Txindoki':     [ 43.0667,   -2.1500],  // peak, Gipuzkoa/Navarra
  'España:Unciti':       [ 42.7476,   -1.5012],  // Unciti, Navarre
  'España:Urederra':     [ 42.7282,   -2.0843],  // Nacedero del Urederra natural park, Navarra
  'España:Rio Urederra': [ 42.7282,   -2.0843],  // alternate name for Urederra
  'España:Numancia':     [ 41.8156,   -2.4394],  // archaeological site near Soria
  'España:Pamplona':     [ 42.8733,   -1.5911],  // pinned at Olloki (Iza valley)
  'España:Panticosa':    [ 42.7333,   -0.2833],  // ski resort, Huesca Pyrenees
  'España:Panticosa_Pedro': [42.7333,  -0.2833],
  'España:Pasaia':       [ 43.3256,   -1.9225],  // Pasaia port, near San Sebastián
  'España:Peniscola':    [ 40.3600,    0.4050],  // Peñíscola, Valencia coast
  'España:Peñiscola':    [ 40.3620,    0.4010],  // Peñíscola (accented key)
  'España:Sabinaningo':  [ 42.5219,   -0.3644],  // Sabiñánigo, Huesca
  'España:Salamanca':    [ 40.9701,   -5.6635],
  'España:San Sebastian': [43.3183,   -1.9812],
  'España:Santander':    [ 43.4628,   -3.8099],
  'España:Segovia':      [ 40.9429,   -4.1088],
  'España:Sevilla':      [ 37.3891,   -5.9845],
  'España:Sos del Rey Catolico': [42.5000, -1.2167], // medieval town, Zaragoza
  'España:Tarragona':    [ 41.1189,    1.2445],
  'España:Teruel':       [ 40.3455,   -1.1062],
  'España:Toledo':       [ 39.8628,   -4.0273],
  'España:Torre Vieja':  [ 37.9784,   -0.6852],  // Torrevieja, Alicante
  'España:Valencia':     [ 39.4699,   -0.3763],
  'España:Talavera de la Reina': [39.9617, -4.8308], // Toledo province
  'España:Vitoria':      [ 42.8467,   -2.6729],  // Vitoria-Gasteiz
  'España:Vitoria-Gasteiz': [42.8467, -2.6729],  // Basque capital (accented key)
  'España:Vittoria':     [ 42.8467,   -2.6729],  // alternative spelling
  'España:Zamora':       [ 41.5035,   -5.7517],
  'España:Zaragoza':     [ 41.6488,   -0.8891],
  'España:Zarautz':      [ 43.2841,   -2.1714],  // coastal town, Basque Country
  'España:Zumaia':       [ 43.2998,   -2.2547],  // coastal town, Gipuzkoa

  // ── Francia (France) ─────────────────────────────────────────────────
  'Francia:':            [ 48.8566,    2.3522],  // Paris (capital fallback)
  'Francia:Biarritz':    [ 43.4831,   -1.5586],  // Biarritz, Basque coast
  'Francia:Bordeaux':    [ 44.8378,   -0.5792],
  'Francia:Carcassonne': [ 43.2130,    2.3491],
  'Francia:Chartres':    [ 48.4469,    1.4891],  // Chartres, Eure-et-Loir
  'Francia:Lourdes':     [ 43.0956,   -0.0463],  // Lourdes, France
  'Francia:Lourdes_Bayona_Biarritz': [43.0956, -0.0463], // Lourdes / Bayonne / Biarritz area (legacy key)
  'Francia:Lyon':        [ 45.7640,    4.8357],
  'Francia:Marsella':    [ 43.2965,    5.3698],
  'Francia:Nice':        [ 43.7102,    7.2620],
  'Francia:París':       [ 48.8566,    2.3522],
  'Francia:Paris':       [ 48.8566,    2.3522],
  'Francia:Perpignan':   [ 42.6887,    2.8948],
  'Francia:Saint Jean Pied Du Port': [43.1628, -1.2371], // start of Camino Frances
  'Francia:San Juan de Luz': [43.3895,  -1.6613], // Saint-Jean-de-Luz
  'Francia:Sare':        [ 43.3105,   -1.5817],  // small Basque village near Spanish border

  // ── Grecia (Greece) ───────────────────────────────────────────────────
  'Grecia:':             [ 37.9838,   23.7275],  // Athens (capital fallback)
  'Grecia:Atenas':       [ 37.9838,   23.7275],

  // ── Guatemala ─────────────────────────────────────────────────────────
  'Guatemala:':          [ 14.6349,  -90.5069],  // Guatemala City (capital fallback)

  // ── Holanda (Netherlands) ─────────────────────────────────────────────
  'Holanda:':            [ 52.3676,    4.9041],  // Amsterdam (capital fallback)
  'Holanda:Amsterdam':   [ 52.3676,    4.9041],
  'Holanda:Delft':       [ 52.0116,    4.3571],
  'Holanda:Eindhoven':   [ 51.4416,    5.4697],
  'Holanda:La Haya':     [ 52.0705,    4.3007],  // The Hague
  'Holanda:Rotterdam':   [ 51.9244,    4.4777],
  'Holanda:Utrecht':     [ 52.0907,    5.1214],
  'Países Bajos:Amsterdam': [52.3676,  4.9041],

  // ── Hungria (Hungary) ─────────────────────────────────────────────────
  'Hungria:':            [ 47.4979,   19.0402],  // Budapest (capital fallback)
  'Hungria:Budapest':    [ 47.4979,   19.0402],

  // ── Inglaterra (England / UK) ─────────────────────────────────────────
  'Inglaterra:':         [ 51.5074,   -0.1278],  // London (capital fallback)
  'Inglaterra:London':   [ 51.5074,   -0.1278],
  'Inglaterra:Londres':  [ 51.5074,   -0.1278],  // folder spelling in Visitas
  'Reino Unido:Londres': [ 51.5074,   -0.1278],
  'Reino Unido:London':  [ 51.5074,   -0.1278],
  'Reino Unido:Edinburgh': [55.9533,  -3.1883],

  // ── Irlanda (Ireland) ─────────────────────────────────────────────────
  'Irlanda:':            [ 53.3498,   -6.2603],  // Dublin (capital fallback)
  'Irlanda:Dublin':      [ 53.3498,   -6.2603],
  'Irlanda:Dublín':      [ 53.3498,   -6.2603],

  // ── Italia (Italy) ────────────────────────────────────────────────────
  'Italia:':             [ 41.9028,   12.4964],  // Rome (capital fallback)
  'Italia:Florencia':    [ 43.7696,   11.2558],
  'Italia:Milan':        [ 45.4654,    9.1859],  // folder spelling in Visitas
  'Italia:Milano':       [ 45.4654,    9.1859],
  'Italia:Milán':        [ 45.4654,    9.1859],
  'Italia:Pisa':         [ 43.7228,   10.4017],
  'Italia:Roma':         [ 41.9028,   12.4964],
  'Italia:Torino':       [ 45.0703,    7.6869],
  'Italia:Venecia':      [ 45.4408,   12.3155],
  'Italia:Nápoles':      [ 40.8518,   14.2681],

  // ── México (Mexico) ───────────────────────────────────────────────────
  'México:':             [ 19.4326,  -99.1332],  // Mexico City (capital fallback)
  'México:México City':  [ 19.4326,  -99.1332],
  'México:Ciudad de México': [19.4326, -99.1332],
  'México:Monterey':     [ 25.6866, -100.3161],  // Monterrey (misspelled in tag)
  'México:Saltillo':     [ 25.4232, -100.9963],

  // ── Monaco ────────────────────────────────────────────────────────────
  'Monaco:':             [ 43.7384,    7.4246],  // Monaco city (capital fallback)

  // ── Noruega (Norway) ──────────────────────────────────────────────────
  'Noruega:':            [ 59.9139,   10.7522],  // Oslo (capital fallback)
  'Noruega:Smola':       [ 63.3667,    8.0000],  // Smøla island, wind energy site
  'Noruega:Trondheim':   [ 63.4305,   10.3951],
  "Noruega:Daniel's":    [ 63.4305,   10.3951],  // Trondheim (folder named after person)

  // ── Paises Balticos (Baltic + Nordic countries, mixed in one folder) ──
  'Paises Balticos:':    [ 59.4370,   24.7536],  // Tallinn (fallback)
  'Paises Balticos:Helsinki': [60.1699, 24.9384], // Helsinki, Finland
  'Paises Balticos:Tallin':   [59.4370, 24.7536], // Tallinn, Estonia

  // ── Republica Checa (Czech Republic) ─────────────────────────────────
  'Republica Checa:':    [ 50.0755,   14.4378],  // Prague (capital fallback)
  'Republica Checa:Praga': [ 50.0755, 14.4378],  // folder spelling in Visitas

  // ── Perú ──────────────────────────────────────────────────────────────
  'Perú:':               [-12.0464,  -77.0428],  // Lima (capital fallback)
  'Perú:Lima':           [-12.0464,  -77.0428],
  'Perú:Cusco':          [-13.5320,  -71.9675],

  // ── Polonia (Poland) ──────────────────────────────────────────────────
  'Polonia:':            [ 52.2297,   21.0122],  // Warsaw (capital fallback)
  'Polonia:Auschwitz':   [ 50.0264,   19.2040],  // Auschwitz-Birkenau, Oświęcim
  'Polonia:Kraków':      [ 50.0647,   19.9450],  // Kraków
  'Polonia:Krakow':      [ 50.0647,   19.9450],  // Kraków (no diacritic variant)
  'Polonia:Wrocław':     [ 51.1079,   17.0385],  // Wrocław
  'Polonia:Wroclaw':     [ 51.1079,   17.0385],  // Wrocław (no diacritic variant)

  // ── Portugal ──────────────────────────────────────────────────────────
  'Portugal:':           [ 38.7223,   -9.1393],  // Lisbon (capital fallback)
  'Portugal:Belem':      [ 38.6974,   -9.2064],  // Belém district, Lisbon
  'Portugal:Cascais':    [ 38.6969,   -9.4227],  // coastal town near Lisbon
  'Portugal:Coimbra':    [ 40.2033,   -8.4103],
  'Portugal:Fatima':     [ 39.6341,   -8.6735],  // Fátima, pilgrimage city
  'Portugal:Fátima':     [ 39.6341,   -8.6735],  // accented key
  'Portugal:Guimaraes':  [ 41.4429,   -8.2969],  // Guimarães, birthplace of Portugal
  'Portugal:Lisboa':     [ 38.7223,   -9.1393],
  'Portugal:Oporto':     [ 41.1579,   -8.6291],
  'Portugal:Porto':      [ 41.1579,   -8.6291],
  'Portugal:Nazaré':     [ 39.6018,   -9.0705],
  'Portugal:Peniche':    [ 39.3561,   -9.3811],
  'Portugal:Peniche_Nazare': [39.4000, -9.1500], // Peniche & Nazaré, Atlantic coast
  'Portugal:Perdigao':   [ 39.7143,   -7.7517],  // Perdigão wind farm, central Portugal
  'Portugal:Sintra':     [ 38.8029,   -9.3817],  // Sintra, UNESCO heritage near Lisbon
  'Portugal:Ericeira':   [ 38.9681,   -9.4073],  // Ericeira, surf town north of Lisbon
  'Portugal:Tavira':     [ 37.1242,   -7.6513],  // Tavira, eastern Algarve

  // ── Suecia (Sweden) ───────────────────────────────────────────────────
  'Suecia:':             [ 59.3293,   18.0686],  // Stockholm (capital fallback)
  'Suecia:Malmo':        [ 55.6050,   13.0038],  // Malmö
  'Suecia:Malmö':        [ 55.6050,   13.0038],  // Malmö (diacritic variant)

  // ── Suiza (Switzerland) ───────────────────────────────────────────────
  'Suiza:':              [ 46.9480,    7.4474],  // Bern (capital fallback)
  'Suiza:Ginebra':       [ 46.2044,    6.1432],
  'Suiza:Geneva':        [ 46.2044,    6.1432],
  'Suiza:Holderbank':    [ 47.4000,    8.1333],  // village in Aargau canton
  'Suiza:Zurich':        [ 47.3769,    8.5417],
  'Suiza:Zúrich':        [ 47.3769,    8.5417],

  // ── Turquia (Turkey) ──────────────────────────────────────────────────
  'Turquia:':            [ 39.9334,   32.8597],  // Ankara (capital fallback)
  'Turquia:Istanbul':    [ 41.0082,   28.9784],
  'Turquia:Estambul':    [ 41.0082,   28.9784],

  // ── USA ───────────────────────────────────────────────────────────────
  'USA:':                [ 38.9072,  -77.0369],  // Washington DC (capital fallback)
  'USA:Boston':          [ 42.3601,  -71.0589],  // Boston, Massachusetts
  'USA:Boulder':         [ 40.0150, -105.2705],  // Boulder, CO
  'USA:Cambria':         [ 35.5588, -121.0796],  // Cambria, California coast
  'USA:Chicago':         [ 41.8781,  -87.6298],
  'USA:Foxboro':         [ 42.0651,  -71.2454],  // Foxborough, Massachusetts
  'USA:Greenville':      [ 34.8526,  -82.3940],  // Greenville, South Carolina
  'USA:Los Angeles':     [ 34.0522, -118.2437],
  'USA:Miami':           [ 25.7617,  -80.1918],  // Miami, Florida
  'USA:New Bedford':     [ 41.6362,  -70.9342],  // New Bedford, Massachusetts
  'USA:New Port':        [ 41.4901,  -71.3128],  // Newport, Rhode Island
  'USA:New York':        [ 40.7128,  -74.0060],  // New York City
  'USA:Povidence':                  [ 41.8240,  -71.4128],  // Providence, RI (folder typo)
  'USA:Providence':                 [ 41.8240,  -71.4128],  // Providence, Rhode Island
  'USA:Providence Rhode Island':    [ 41.8240,  -71.4128],  // Providence, RI (folder name variant)
  'USA:San Diego':       [ 32.7157, -117.1611],
  'USA:San Francisco':   [ 37.7749, -122.4194],
  'USA:Silicon Valley':  [ 37.3875, -122.0575],  // Santa Clara County tech hub
  'USA:Six Flags New England': [42.0681, -72.5757], // Agawam, Massachusetts
  'USA:Washington CD':   [ 38.9072,  -77.0369],  // Washington DC (folder typo kept for backward compat)
  'USA:Washington DC':   [ 38.9072,  -77.0369],  // Washington DC

  // ── Uruguay ───────────────────────────────────────────────────────────
  'Uruguay:':            [-34.9011,  -56.1645],  // Montevideo (capital fallback)
  'Uruguay:Colonia':     [-34.4626,  -57.8400],  // Colonia del Sacramento
};

// Returns coordinates for a sys tag's country+city.
// Falls back by splitting city on ' - ' then '/' to find shorter place-name keys,
// then country capital, then null.
export function sysTagCoords(country: string, city: string): [number, number] | null {
  const exact = SYS_TAG_COORDS[country + ':' + city];
  if (exact) return exact;
  for (const sep of [' - ', '/']) {
    const idx = city.indexOf(sep);
    if (idx > 0) {
      const hit = SYS_TAG_COORDS[country + ':' + city.slice(0, idx).trim()];
      if (hit) return hit;
    }
  }
  // Strip trailing space+number: "Lisboa 1" / "Lisboa 2" → "Lisboa"
  const stripped = city.replace(/\s+\d+$/, '').trim();
  if (stripped && stripped !== city) {
    const hit = SYS_TAG_COORDS[country + ':' + stripped];
    if (hit) return hit;
  }
  return SYS_TAG_COORDS[country + ':'] ?? null;
}

// ── Translation tables ────────────────────────────────────────────────────
// Maps sys-tag canonical country name (Spanish) → bilingual display names
export const COUNTRY_NAMES: Record<string, { en: string; es: string }> = {
  'Alemania':        { en: 'Germany',        es: 'Alemania' },
  'Andorra':         { en: 'Andorra',         es: 'Andorra' },
  'Argentina':       { en: 'Argentina',       es: 'Argentina' },
  'Australia':       { en: 'Australia',       es: 'Australia' },
  'Austria':         { en: 'Austria',         es: 'Austria' },
  'Belgica':         { en: 'Belgium',         es: 'Bélgica' },
  'Bolivia':         { en: 'Bolivia',         es: 'Bolivia' },
  'Brasil':          { en: 'Brazil',          es: 'Brasil' },
  'Canada':          { en: 'Canada',          es: 'Canadá' },
  'Chile':           { en: 'Chile',           es: 'Chile' },
  'Colombia':        { en: 'Colombia',        es: 'Colombia' },
  'Costa Rica':      { en: 'Costa Rica',      es: 'Costa Rica' },
  'Croatia':         { en: 'Croatia',         es: 'Croacia' },
  'Cuba':            { en: 'Cuba',            es: 'Cuba' },
  'Dinamarca':       { en: 'Denmark',         es: 'Dinamarca' },
  'Egipto':          { en: 'Egypt',           es: 'Egipto' },
  'Eslovaquia':      { en: 'Slovakia',         es: 'Eslovaquia' },
  'España':          { en: 'Spain',           es: 'España' },
  'Francia':         { en: 'France',          es: 'Francia' },
  'Grecia':          { en: 'Greece',          es: 'Grecia' },
  'Guatemala':       { en: 'Guatemala',       es: 'Guatemala' },
  'Holanda':         { en: 'Netherlands',     es: 'Holanda' },
  'Hungria':         { en: 'Hungary',         es: 'Hungría' },
  'Inglaterra':      { en: 'England',         es: 'Inglaterra' },
  'Irlanda':         { en: 'Ireland',         es: 'Irlanda' },
  'Israel':          { en: 'Israel',          es: 'Israel' },
  'Italia':          { en: 'Italy',           es: 'Italia' },
  'Japón':           { en: 'Japan',           es: 'Japón' },
  'México':          { en: 'Mexico',          es: 'México' },
  'Monaco':          { en: 'Monaco',          es: 'Mónaco' },
  'Noruega':         { en: 'Norway',          es: 'Noruega' },
  'Paises Balticos': { en: 'Baltic States',   es: 'Países Bálticos' },
  'Perú':            { en: 'Peru',            es: 'Perú' },
  'Polonia':         { en: 'Poland',          es: 'Polonia' },
  'Portugal':        { en: 'Portugal',        es: 'Portugal' },
  'Republica Checa': { en: 'Czech Republic',  es: 'República Checa' },
  'Suecia':          { en: 'Sweden',           es: 'Suecia' },
  'Suiza':           { en: 'Switzerland',     es: 'Suiza' },
  'Tailandia':       { en: 'Thailand',        es: 'Tailandia' },
  'Turquia':         { en: 'Turkey',          es: 'Turquía' },
  'UAE':             { en: 'UAE',             es: 'Emiratos Árabes' },
  'Uruguay':         { en: 'Uruguay',         es: 'Uruguay' },
  'USA':             { en: 'USA',             es: 'EE.UU.' },
};

// Maps English/Nominatim country names → sys-tag canonical (Spanish)
// Used to normalize real geo data so it can be matched against sys tags
export const GEO_TO_SYS: Record<string, string> = {
  'Austria':        'Austria',
  'Germany':        'Alemania',
  'Spain':          'España',
  'France':         'Francia',
  'Italy':          'Italia',
  'Netherlands':    'Holanda',
  'Belgium':        'Belgica',
  'Ireland':        'Irlanda',
  'Denmark':        'Dinamarca',
  'Norway':         'Noruega',
  'Hungary':        'Hungria',
  'Turkey':         'Turquia',
  'Greece':         'Grecia',
  'Poland':         'Polonia',
  'Sweden':         'Suecia',
  'Switzerland':    'Suiza',
  'United Kingdom': 'Inglaterra',
  'England':        'Inglaterra',
  'Egypt':          'Egipto',
  'Japan':          'Japón',
  'Thailand':       'Tailandia',
  'Mexico':         'México',
  'Brazil':         'Brasil',
  'Portugal':       'Portugal',
  'Canada':         'Canada',
  'Australia':      'Australia',
  'Israel':         'Israel',
  'Croatia':        'Croatia',
  'Slovakia':       'Eslovaquia',
  'Czech Republic': 'Republica Checa',
  'Colombia':       'Colombia',
  'Argentina':      'Argentina',
  'Guatemala':      'Guatemala',
  'Uruguay':        'Uruguay',
  'Monaco':         'Monaco',
  'Cuba':           'Cuba',
  'Chile':          'Chile',
  'Perú':           'Perú',
  'Peru':           'Perú',
  'México':         'México',
};

// City name translations (all known variants → {en, es})
const CITY_NAMES: Record<string, { en: string; es: string }> = {
  // Egypt
  'El Cairo':     { en: 'Cairo',       es: 'El Cairo' },
  'Cairo':        { en: 'Cairo',       es: 'El Cairo' },
  // Germany
  'Berlin':       { en: 'Berlin',      es: 'Berlín' },
  'Berlín':       { en: 'Berlin',      es: 'Berlín' },
  'Hamburg':      { en: 'Hamburg',     es: 'Hamburgo' },
  'Hamburgo':     { en: 'Hamburg',     es: 'Hamburgo' },
  'Cologne':      { en: 'Cologne',     es: 'Colonia' },
  'Colonia':      { en: 'Cologne',     es: 'Colonia' },
  'Munich':       { en: 'Munich',      es: 'Múnich' },
  'Múnich':       { en: 'Munich',      es: 'Múnich' },
  // Japan
  'Tokyo':        { en: 'Tokyo',       es: 'Tokio' },
  'Tokio':        { en: 'Tokyo',       es: 'Tokio' },
  // Thailand
  'Bangkok':      { en: 'Bangkok',     es: 'Bangkok' },
  'Bankok':       { en: 'Bangkok',     es: 'Bangkok' },
  // Israel
  'Jerusalem':    { en: 'Jerusalem',   es: 'Jerusalén' },
  'Jerusalén':    { en: 'Jerusalem',   es: 'Jerusalén' },
  // Italy
  'Rome':         { en: 'Rome',        es: 'Roma' },
  'Roma':         { en: 'Rome',        es: 'Roma' },
  'Florence':     { en: 'Florence',    es: 'Florencia' },
  'Florencia':    { en: 'Florence',    es: 'Florencia' },
  'Venice':       { en: 'Venice',      es: 'Venecia' },
  'Venecia':      { en: 'Venice',      es: 'Venecia' },
  'Milan':        { en: 'Milan',       es: 'Milán' },
  'Milán':        { en: 'Milan',       es: 'Milán' },
  // Denmark
  'Copenhagen':    { en: 'Copenhagen', es: 'Copenhague' },
  'Copenhaguen':   { en: 'Copenhagen', es: 'Copenhague' },
  'Copenhague':    { en: 'Copenhagen', es: 'Copenhague' },
  // France
  'Marseille':    { en: 'Marseille',   es: 'Marsella' },
  'Marsella':     { en: 'Marseille',   es: 'Marsella' },
  // Greece
  'Athens':       { en: 'Athens',      es: 'Atenas' },
  'Atenas':       { en: 'Athens',      es: 'Atenas' },
  // Belgium
  'Brussels':     { en: 'Brussels',    es: 'Bruselas' },
  'Bruselas':     { en: 'Brussels',    es: 'Bruselas' },
  'Bruges':       { en: 'Bruges',      es: 'Brujas' },
  'Brujas':       { en: 'Bruges',      es: 'Brujas' },
  'Brugge':       { en: 'Bruges',      es: 'Brujas' },
  'Antwerp':      { en: 'Antwerp',     es: 'Amberes' },
  'Antwerpen':    { en: 'Antwerp',     es: 'Amberes' },
  // Turkey
  'Istanbul':     { en: 'Istanbul',    es: 'Estambul' },
  'Estambul':     { en: 'Istanbul',    es: 'Estambul' },
  // Portugal
  'Lisbon':       { en: 'Lisbon',      es: 'Lisboa' },
  'Lisboa':       { en: 'Lisbon',      es: 'Lisboa' },
  // Switzerland
  'Geneva':       { en: 'Geneva',      es: 'Ginebra' },
  'Ginebra':      { en: 'Geneva',      es: 'Ginebra' },
  // Ireland
  'Dublin':       { en: 'Dublin',      es: 'Dublín' },
  'Dublín':       { en: 'Dublin',      es: 'Dublín' },
  // Cuba
  'Havana':       { en: 'Havana',      es: 'La Habana' },
  'La Habana':    { en: 'Havana',      es: 'La Habana' },
  // Egypt others
  'Alexandria':   { en: 'Alexandria',  es: 'Alejandría' },
  'Alejandría':   { en: 'Alexandria',  es: 'Alejandría' },
  // England
  'London':       { en: 'London',      es: 'Londres' },
  'Londres':      { en: 'London',      es: 'Londres' },
};

/**
 * Translate a country name (sys-tag canonical OR English Nominatim) to the display language.
 * Falls back to the original name if no translation is found.
 */
export function translateCountry(name: string, lang: 'en' | 'es'): string {
  const canonical = GEO_TO_SYS[name] ?? name; // normalize English geo names to sys-tag form
  return COUNTRY_NAMES[canonical]?.[lang] ?? canonical;
}

/**
 * Translate a city name to the display language.
 * Falls back to the original name if no translation is found.
 */
export function translateCity(name: string, lang: 'en' | 'es'): string {
  return CITY_NAMES[name]?.[lang] ?? name;
}

/** Haversine distance in km between two lat/lng points. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
