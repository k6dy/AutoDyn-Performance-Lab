// Vocabulary for the local automotive relevance gate (see relevance.ts). Grouped by topic so it can
// be extended without touching the scoring logic. All entries are lowercase; single words are
// matched per token (with simple plural stripping and small-typo tolerance for long words),
// phrases are matched on the normalized text.

/** Unambiguously automotive words: one is enough. */
export const STRONG_WORDS = [
  "airbag", "airbags", "seatbelt", "seatbelts", "headlight", "headlights", "taillight", "taillights", "windshield", "wiper", "wipers",
  "bumper", "fender", "dmv", "carplay", "hubcap", "lugnut", "lugnuts",
  "car", "cars", "automobile", "automotive", "vehicle", "truck", "suv", "sedan", "coupe", "hatchback", "roadster", "minivan", "motorcycle",
  "motorbike", "supercar", "hypercar", "musclecar", "jdm", "engine", "turbo", "turbocharger", "turbocharged", "biturbo", "twinturbo",
  "supercharger", "supercharged", "intercooler", "wastegate", "blowoff", "bov", "downpipe", "midpipe", "catback", "camshaft", "crankshaft",
  "conrod", "valvetrain", "naturally", "aspirated", "v6", "v8", "v10", "v12", "w12", "i4", "i6", "wankel", "flat6", "redline", "rpm",
  "dyno", "horsepower", "hp", "bhp", "whp", "torque", "lbft", "ecu", "pcm", "tcu", "remap", "chiptune", "afr", "lambda", "knock",
  "detonation", "preignition", "misfire", "misfiring", "carburetor", "gasoline", "petrol", "diesel", "octane", "e85", "methanol",
  "sparkplug", "coilpack", "gasket", "headgasket", "blowby", "pcv", "egr", "dpf", "catalytic", "catless", "maf", "iat", "boostgauge",
  "muffler", "resonator", "turbolag", "antilag", "nitrous", "nos", "flywheel", "coolant", "radiator", "thermostat", "waterpump",
  "alternator", "serpentine", "drivebelt", "hemi", "ecoboost", "vtec", "vanos", "skyactiv", "tfsi", "tsi", "duramax", "cummins",
  "powerstroke", "transmission", "gearbox", "dct", "dsg", "pdk", "cvt", "clutch", "torqueconverter", "differential", "diff", "lsd",
  "locker", "axle", "axles", "halfshaft", "driveshaft", "propshaft", "transaxle", "awd", "rwd", "fwd", "4wd", "4x4", "xdrive", "quattro",
  "4matic", "drivetrain", "driveline", "gearing", "downshift", "upshift", "suspension", "coilover", "coilovers", "struts", "strut",
  "swaybar", "antiroll", "camber", "caster", "understeer", "oversteer", "subframe", "brake", "brakes", "braking", "tire", "tires", "tyre",
  "tyres", "treadwear", "slicks", "semislick", "downforce", "wheelbase", "weight-transfer", "ev", "evs", "phev", "bev", "regenerative",
  "supercharging", "mechanic", "obd", "obd2", "obdii", "dtc", "odometer", "mpg", "0-60", "0-100", "quarter-mile", "dragstrip", "laptime",
  "trackday", "motorsport", "autocross", "nurburgring", "horsepower-to-weight", "autodyn",
];

/** Multi-word automotive phrases (matched on the normalized text). */
export const STRONG_PHRASES = [
  "torque converter", "limited slip", "dual clutch", "check engine", "head gasket", "timing belt", "timing chain", "spark plug", "coil pack",
  "fuel pump", "fuel injector", "oil change", "oil pressure", "tire pressure", "wheel alignment", "sway bar", "anti roll", "ride height",
  "lap time", "top speed", "quarter mile", "zero to sixty", "0 to 60", "power to weight", "curb weight", "drag coefficient", "gear ratio",
  "final drive", "launch control", "traction control", "stability control", "blow off valve", "cat delete", "cold air", "air filter",
  "brake pads", "brake fluid", "steering wheel", "fuel economy", "gas mileage", "miles per gallon", "test drive", "track day", "drag strip",
  "engine code", "trouble code", "exhaust system", "intake system", "manual transmission", "automatic transmission", "stick shift",
  "tune up", "drag race", "drag racing", "race car", "race track", "launch control", "oil leak", "oil filter", "fuel system", "brake rotor", "error code", "engine light", "body roll", "weight reduction", "weight transfer", "contact patch",
  "rolling resistance", "frontal area", "stock vs modified", "stock and modified", "traction limited", "naturally aspirated",
  "forced induction", "turbo lag", "boost pressure", "intake manifold", "exhaust manifold", "electric vehicle", "electric car", "charging station",
  "fast charging", "battery pack", "range anxiety", "model 3", "model s", "model y", "model x", "type r", "e class", "c class", "s class",
  "g class", "3 series", "5 series", "m sport", "gt3", "gt r", "alfa romeo", "aston martin", "land rover", "range rover", "rolls royce",
  "harley davidson", "mini cooper", "dodge charger", "dodge challenger", "ford focus", "ford fiesta", "honda civic", "honda accord",
  "porsche 911", "lincoln navigator", "jaguar f type", "smart fortwo", "flat tire", "flat tyre", "change a flat", "spare tire", "jump start",
  "dead battery", "parking brake", "turn signal", "license plate", "android auto", "apple carplay", "windshield wipers", "car battery",
];

/** Context-dependent words: automotive in this app, but too common alone to prove it. */
export const MEDIUM_WORDS = [
  "speed", "fast", "faster", "quick", "quicker", "slow", "power", "powerful", "weight", "heavy", "light", "lighter", "drive", "driving",
  "driver", "road", "highway", "commute", "battery", "charging", "charge", "electric", "cat", "stock", "upgrade", "upgrades", "parts",
  "part", "aftermarket", "build", "mod", "performance", "reliability", "reliable", "repair", "fix", "noise", "rattle", "vibration",
  "vibrates", "squeal", "leak", "leaking", "smoke", "pull", "pulls", "sound", "loud", "filter", "sensor", "dashboard", "warning", "garage",
  "seat", "seats", "interior", "trim", "model", "horse", "mph", "kph", "km/h", "miles", "analyze", "analysis", "results", "compare",
  "comparison", "scenario", "stock-vs-modified", "lb", "lbs", "pounds", "kg", "psi", "bar", "lease", "insurance", "msrp", "price", "cost",
  "worth", "buy", "buying", "sell", "trade", "winter", "snow", "rain", "wet", "mud", "offroad", "towing", "tow", "hauling", "payload",
  "efficiency", "economy", "manual", "automatic", "stick", "trans", "flash", "spark", "map", "range", "service", "servicing", "inspection",
  "warranty", "track", "drag", "rev", "revs", "trap", "launch", "converter", "transfer", "crank", "rods", "lag", "wing", "headers",
  "intake", "valve", "valves", "na", "ps", "nm", "kw", "o2", "cel", "def", "tune", "tuned", "tuning", "timing", "belt", "starter", "rust",
  "wax", "dealer", "dealership", "recall", "recalls", "tread", "pads", "toe", "gear", "gears", "shift", "shifts", "shifting", "wheels",
  "hatch", "rocker", "spool", "spooling", "idle", "oil", "fuel", "boost", "boosted", "mods", "modified", "modification", "modifications",
  "simulation", "simulate", "racing", "drift", "drifting", "sensitivity", "feasibility", "feasible", "compression", "ignition", "cams",
  "lifter", "lifters", "rotor", "rotors", "caliper", "calipers", "shocks", "springs", "damper", "dampers", "bushing", "bushings",
  "steering", "handling", "cornering", "abs", "grip", "traction", "aero", "spoiler", "diffuser", "splitter", "rims", "throttle",
  "displacement", "liter", "litre", "cylinder", "cylinders", "piston", "pistons", "manifold", "inline", "boxer", "rotary", "liftoff",
  "chassis", "acceleration", "accelerate", "hybrid", "regen", "kwh", "emissions", "smog", "maintenance", "mileage", "detailing", "oem",
  "burnout", "convertible", "pickup", "crossover", "wagon", "alignment", "exhaust", "carb", "paddle", "paddles", "synchro", "injector",
  "injectors", "alfa", "romeo", "aston", "martin", "dodge", "genesis", "holden", "jaguar", "land", "rover", "lincoln", "lotus", "lucid",
  "mercury", "mini", "plymouth", "ram", "rolls", "royce", "saturn", "scion", "smart", "triumph", "kawasaki", "yamaha", "harley",
  "davidson", "civic", "accord", "prelude", "tundra", "challenger", "charger", "viper", "demon", "cherokee", "gladiator", "bronco",
  "raptor", "sierra", "tahoe", "explorer", "focus", "fiesta", "golf", "beetle", "sti", "outback", "evo", "eclipse", "sonata", "stinger",
  "m2", "x5", "x3", "tt", "911", "cayenne", "f8", "488", "458", "roma", "plaid", "kona", "leaf", "bolt", "volt", "lightning", "ghibli",
  "si", "13b", "20b", "barra", "coyote",
];

/** Manufacturers (and common short forms). */
export const MAKES = [
  "acura", "audi", "bentley", "bmw", "bugatti", "buick", "byd", "cadillac", "chevrolet", "chevy", "chrysler", "citroen", "cupra", "dacia",
  "daewoo", "datsun", "ferrari", "fiat", "fisker", "ford", "gmc", "honda", "hummer", "hyundai", "infiniti", "isuzu", "jeep", "kia",
  "koenigsegg", "lada", "lamborghini", "lambo", "lancia", "landrover", "lexus", "maserati", "maybach", "mazda", "mclaren", "mercedes",
  "benz", "mercedes-benz", "merc", "mitsubishi", "nissan", "oldsmobile", "opel", "pagani", "peugeot", "polestar", "pontiac", "porsche",
  "renault", "rivian", "saab", "skoda", "subaru", "suzuki", "tesla", "toyota", "vauxhall", "volkswagen", "vw", "volvo", "yugo", "ducati",
];

/** Well-known model names, trims and engine codes (letter-digit codes are also detected by pattern). */
export const MODELS = [
  "integra", "nsx", "s2000", "crx", "corolla", "camry", "supra", "celica", "mr2", "tacoma", "4runner", "rav4", "prius", "highlander",
  "mustang", "camaro", "corvette", "vette", "hellcat", "trackhawk", "srt", "wrangler", "f150", "f-150", "f250", "silverado", "suburban",
  "escalade", "durango", "gti", "jetta", "passat", "tiguan", "wrx", "impreza", "forester", "brz", "gr86", "frs", "fr-s", "miata", "mx5",
  "mx-5", "rx7", "rx-7", "rx8", "rx-8", "mazdaspeed", "skyline", "gtr", "gt-r", "370z", "350z", "240sx", "silvia", "altima", "maxima",
  "lancer", "elantra", "veloster", "telluride", "amg", "m3", "m4", "m5", "m8", "m340i", "340i", "330i", "335i", "135i", "m235i", "c300",
  "c43", "c63", "e350", "e63", "s550", "s63", "cla", "gla", "glc", "gle", "a4", "s4", "rs4", "a5", "s5", "rs5", "rs3", "rs6", "rs7", "r8",
  "cayman", "boxster", "macan", "taycan", "panamera", "carrera", "huracan", "aventador", "urus", "sf90", "720s", "765lt", "chiron",
  "veyron", "model3", "cybertruck", "ioniq", "mach-e", "elise", "exige", "evora", "giulia", "stelvio", "ct4", "ct5", "blackwing", "is350",
  "rc350", "rcf", "gs350", "lc500", "lfa", "q50", "q60", "g35", "g37", "tlx", "rdx", "mdx", "ilx", "type-r", "2jz", "1jz", "rb26", "rb25",
  "sr20", "ka24", "vq35", "vr38", "k20", "k24", "b16", "b18", "f20c", "4g63", "ej20", "ej25", "ej257", "fa20", "fa24", "ls1", "ls2", "ls3",
  "ls7", "lt1", "lt4", "lt5", "b58", "b48", "n54", "n55", "s55", "s58", "s65", "s85", "m156", "m157", "m177", "m178", "m256", "ea888",
  "ea113", "ea855", "4b11", "g4kh",
];

/** Topics outside AutoDyn's scope. A match counts against the message. */
export const OFF_TOPIC_WORDS = [
  // animals & nature
  "cow", "cows", "penguin", "penguins", "dog", "dogs", "puppy", "kitten", "cats", "bird", "birds", "hibernate", "hibernation", "dinosaur",
  "dinosaurs", "whale", "shark", "sharks", "elephant", "giraffe", "bees", "flower", "flowers", "plant", "plants", "garden", "gardening",
  // food
  "recipe", "recipes", "bake", "baking", "cook", "cooking", "cake", "pasta", "pizza", "cookies", "soup", "salad", "olive", "vegan",
  // writing & entertainment
  "poem", "poems", "poetry", "haiku", "sonnet", "limerick", "lyrics", "song", "songs", "rap", "essay", "essays", "homework", "novel",
  "fanfic", "joke", "jokes", "riddle", "riddles", "movie", "movies", "netflix", "anime", "celebrity", "actor", "actress", "tiktok",
  "instagram", "videogame", "minecraft", "fortnite", "pokemon",
  // general knowledge & school
  "capital", "president", "presidents", "election", "politics", "senator", "congress", "parliament", "religion", "bible", "history",
  "geography", "algebra", "calculus", "chemistry", "biology", "planet", "planets", "galaxy", "universe", "astronomy", "translate",
  "translation", "spanish", "french", "german", "italian", "japanese", "grammar",
  // weather, health, life
  "weather", "forecast", "temperature-tomorrow", "horoscope", "zodiac", "astrology", "diet", "calories", "workout", "doctor", "medicine",
  "symptoms", "pregnant", "dating", "girlfriend", "boyfriend", "wedding", "love",
  // finance & tech
  "invest", "investing", "investment", "investments", "funds", "retirement", "401k", "savings", "bitcoin", "crypto", "cryptocurrency", "ethereum", "nft", "stocks", "dividend", "forex", "mortgage", "python", "javascript", "typescript",
  "java", "sql", "html", "css", "react", "programming", "coding", "algorithm", "chatgpt", "excel", "spreadsheet",
  // sports (not motorsport)
  "football", "soccer", "basketball", "baseball", "nfl", "nba", "nhl", "tennis", "golf-course",
];

/** Off-topic phrases (stronger evidence than single words). */
export const OFF_TOPIC_PHRASES = [
  "capital of", "write a poem", "write me a poem", "write a story", "write an essay", "my essay", "history essay", "tell me a joke",
  "a joke about", "stock market", "stock price", "share price", "meaning of life", "who won", "who is the president", "what time is it",
  "weather tomorrow", "weather today", "recipe for", "how to cook", "how to bake", "lose weight", "in spanish", "in french", "do my homework",
  "solve this equation", "write code", "write a function", "fix my code", "search engine", "game engine", "unreal engine", "unity engine",
  "differential equation", "virus transmission", "suspended from school", "school suspension", "customer service", "user manual",
];

/** Words that make a short message a likely follow-up to the previous turn. */
export const FOLLOW_UP_MARKERS = [
  "that", "this", "it", "its", "those", "these", "them", "they", "one", "ones", "other", "option", "options", "again", "more", "simpler",
  "simply", "else", "instead", "same", "difference", "differences", "disadvantages", "disadvantage", "advantages",
  "advantage", "pros", "cons", "downsides", "downside", "drawbacks", "drawback", "benefits", "benefit", "risks", "risk", "cost", "costs",
  "price", "expensive", "cheap", "reliability", "reliable", "durable", "durability", "safe", "safer", "legal", "worth", "better", "worse",
  "best", "alternatives", "alternative", "example", "examples", "elaborate", "expand", "explain", "clarify", "detail", "details",
  "continue", "longer", "shorter", "affect", "affects", "effect", "impact", "change", "improve", "mean", "means", "work", "works",
];

/** Messages answered locally without any AI request. */
export const SMALL_TALK = /^(?:hi|hello|hey|hiya|yo|good (?:morning|afternoon|evening)|thanks?(?: you)?(?: so much| a lot)?|thank you(?: very much)?|thx|ty|cheers|ok(?:ay)?|cool|great|nice|awesome|got it|perfect|sounds good|bye|goodbye|see you)[!. ]*$/i;

/** Attempts to change the assistant's role or extract its instructions. */
export const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(?:instructions?|rules?|prompt|guidelines?|restrictions?|constraints?|system|programming|automotive)\b/i,
  /\bpretend\b[^.?!]{0,30}\b(?:you(?:'re| are)?|to be)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:act|behave|respond|roleplay|role-play) as (?:an? )?(?:unrestricted|general|different|new|uncensored|jailbroken|evil|dan)\b/i,
  /\b(?:jailbreak|jail-break|dan mode|developer mode|god mode|unrestricted (?:mode|chatbot|assistant|ai)|no restrictions|without restrictions)\b/i,
  /\b(?:system prompt|your (?:instructions|rules|prompt)|hidden instructions|initial prompt)\b/i,
  /\bnew (?:instructions|rules|persona)\b/i,
];
