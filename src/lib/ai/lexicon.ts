// Vocabulary for the local automotive relevance gate (see relevance.ts). Grouped by topic so it can
// be extended without touching the scoring logic. All entries are lowercase; single words are
// matched per token (with simple plural stripping and small-typo tolerance for long words),
// phrases are matched on the normalized text.

/** Unambiguously automotive words: one is enough. */
export const STRONG_WORDS = [
  "airbag", "airbags", "seatbelt", "seatbelts", "headlight", "headlights", "taillight", "taillights", "windshield", "wiper", "wipers",
  "bumper", "fender", "dmv", "carplay", "hubcap", "lugnut", "lugnuts", "car", "cars", "automobile", "automotive", "vehicle", "truck",
  "suv", "sedan", "coupe", "hatchback", "roadster", "minivan", "motorcycle", "motorbike", "supercar", "hypercar", "musclecar", "jdm",
  "engine", "turbo", "turbocharger", "turbocharged", "biturbo", "twinturbo", "supercharger", "supercharged", "intercooler", "wastegate",
  "blowoff", "bov", "downpipe", "midpipe", "catback", "camshaft", "crankshaft", "conrod", "valvetrain", "naturally", "aspirated", "v6",
  "v8", "v10", "v12", "w12", "i4", "i6", "wankel", "flat6", "redline", "rpm", "dyno", "horsepower", "hp", "bhp", "whp", "torque", "lbft",
  "ecu", "pcm", "tcu", "remap", "chiptune", "afr", "lambda", "knock", "detonation", "preignition", "misfire", "misfiring", "carburetor",
  "gasoline", "petrol", "diesel", "octane", "e85", "methanol", "sparkplug", "coilpack", "gasket", "headgasket", "blowby", "pcv", "egr",
  "dpf", "catalytic", "catless", "maf", "iat", "boostgauge", "muffler", "resonator", "turbolag", "antilag", "nitrous", "nos", "flywheel",
  "coolant", "radiator", "thermostat", "waterpump", "alternator", "serpentine", "drivebelt", "hemi", "ecoboost", "vtec", "vanos",
  "skyactiv", "tfsi", "tsi", "duramax", "cummins", "powerstroke", "transmission", "gearbox", "dct", "dsg", "pdk", "cvt", "clutch",
  "torqueconverter", "differential", "diff", "lsd", "locker", "axle", "axles", "halfshaft", "driveshaft", "propshaft", "transaxle", "awd",
  "rwd", "fwd", "4wd", "4x4", "xdrive", "quattro", "4matic", "drivetrain", "driveline", "gearing", "downshift", "upshift", "suspension",
  "coilover", "coilovers", "struts", "strut", "swaybar", "antiroll", "camber", "caster", "understeer", "oversteer", "subframe", "brake",
  "brakes", "braking", "tire", "tires", "tyre", "tyres", "treadwear", "slicks", "semislick", "downforce", "wheelbase", "weight-transfer",
  "ev", "evs", "phev", "bev", "regenerative", "supercharging", "mechanic", "obd", "obd2", "obdii", "dtc", "odometer", "mpg", "0-60",
  "0-100", "quarter-mile", "dragstrip", "laptime", "trackday", "motorsport", "autocross", "nurburgring", "horsepower-to-weight", "autodyn",
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
  "injectors", "alfa", "romeo", "aston", "martin", "dodge", "holden", "land", "rover", "lucid", "mini", "plymouth", "rolls", "royce",
  "scion", "smart", "triumph", "kawasaki", "yamaha", "harley", "davidson", "civic", "accord", "prelude", "tundra", "challenger", "charger",
  "demon", "cherokee", "gladiator", "sierra", "tahoe", "explorer", "focus", "fiesta", "golf", "sti", "outback", "evo", "sonata", "stinger",
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
  "camaro", "corvette", "vette", "hellcat", "trackhawk", "srt", "wrangler", "f150", "f-150", "f250", "silverado", "suburban", "escalade",
  "durango", "gti", "jetta", "passat", "tiguan", "wrx", "impreza", "forester", "brz", "gr86", "frs", "fr-s", "miata", "mx5", "mx-5", "rx7",
  "rx-7", "rx8", "rx-8", "mazdaspeed", "skyline", "gtr", "gt-r", "370z", "350z", "240sx", "silvia", "altima", "maxima", "lancer",
  "elantra", "veloster", "telluride", "amg", "m3", "m4", "m5", "m8", "m340i", "340i", "330i", "335i", "135i", "m235i", "c300", "c43",
  "c63", "e350", "e63", "s550", "s63", "cla", "gla", "glc", "gle", "a4", "s4", "rs4", "a5", "s5", "rs5", "rs3", "rs6", "rs7", "r8",
  "cayman", "boxster", "macan", "taycan", "panamera", "carrera", "huracan", "aventador", "urus", "sf90", "720s", "765lt", "chiron",
  "veyron", "model3", "cybertruck", "ioniq", "mach-e", "elise", "exige", "evora", "giulia", "stelvio", "ct4", "ct5", "blackwing", "is350",
  "rc350", "rcf", "gs350", "lc500", "lfa", "q50", "q60", "g35", "g37", "tlx", "rdx", "mdx", "ilx", "type-r", "2jz", "1jz", "rb26", "rb25",
  "sr20", "ka24", "vq35", "vr38", "k20", "k24", "b16", "b18", "f20c", "4g63", "ej20", "ej25", "ej257", "fa20", "fa24", "ls1", "ls2", "ls3",
  "ls7", "lt1", "lt4", "lt5", "b58", "b48", "n54", "n55", "s55", "s58", "s65", "s85", "m156", "m157", "m177", "m178", "m256", "ea888",
  "ea113", "ea855", "4b11", "g4kh",
];

/** Topics outside AutoDyn's scope. A match counts against the message. */
export const OFF_TOPIC_WORDS = [
  "cow", "cows", "penguin", "penguins", "dog", "dogs", "puppy", "kitten", "cats", "bird", "birds", "hibernate", "hibernation", "dinosaur",
  "dinosaurs", "whale", "shark", "sharks", "elephant", "giraffe", "bees", "flower", "flowers", "plant", "plants", "garden", "gardening",
  "recipe", "recipes", "bake", "baking", "cook", "cooking", "cake", "pasta", "pizza", "cookies", "soup", "salad", "olive", "vegan", "poem",
  "poems", "poetry", "haiku", "sonnet", "limerick", "lyrics", "song", "songs", "rap", "essay", "essays", "homework", "novel", "fanfic",
  "joke", "jokes", "riddle", "riddles", "movie", "movies", "netflix", "anime", "celebrity", "actor", "actress", "tiktok", "instagram",
  "videogame", "minecraft", "fortnite", "pokemon", "capital", "president", "presidents", "election", "politics", "senator", "congress",
  "parliament", "religion", "bible", "history", "geography", "algebra", "calculus", "chemistry", "biology", "planet", "planets", "galaxy",
  "universe", "astronomy", "translate", "translation", "spanish", "french", "german", "italian", "japanese", "grammar", "weather",
  "forecast", "temperature-tomorrow", "horoscope", "zodiac", "astrology", "diet", "calories", "workout", "doctor", "medicine", "symptoms",
  "pregnant", "dating", "girlfriend", "boyfriend", "wedding", "love", "invest", "investing", "investment", "investments", "funds",
  "retirement", "401k", "savings", "bitcoin", "crypto", "cryptocurrency", "ethereum", "nft", "stocks", "dividend", "forex", "mortgage",
  "python", "javascript", "typescript", "java", "sql", "html", "css", "react", "programming", "coding", "algorithm", "chatgpt", "excel",
  "spreadsheet", "football", "soccer", "basketball", "baseball", "nfl", "nba", "nhl", "tennis", "golf-course", "gossip", "celebrities",
  "animal", "animals", "zoo", "wildlife", "deer", "jungle", "safari", "telescope", "stars", "constellation", "moon", "quiz", "exam",
  "lottery", "casino", "poker", "horoscopes",
];

/** Off-topic phrases (stronger evidence than single words). */
export const OFF_TOPIC_PHRASES = [
  "capital of", "write a poem", "write me a poem", "write a story", "write an essay", "my essay", "history essay", "tell me a joke",
  "a joke about", "stock market", "stock price", "share price", "meaning of life", "who won", "who is the president", "what time is it",
  "weather tomorrow", "weather today", "recipe for", "how to cook", "how to bake", "lose weight", "in spanish", "in french", "do my homework",
  "solve this equation", "write code", "write a function", "fix my code", "search engine", "game engine", "unreal engine", "unity engine",
  "differential equation", "virus transmission", "suspended from school", "school suspension", "customer service", "user manual",
];

/**
 * Off-topic words that name a non-automotive *task* (a poem, homework, a recipe…). Unlike topic
 * words (weather, physics, finance), a task is never rescued by an automotive mention.
 */
export const TASK_OFF_WORDS = [
  "poem", "poems", "poetry", "haiku", "sonnet", "limerick", "lyrics", "song", "songs", "rap", "essay", "essays", "homework", "novel",
  "fanfic", "joke", "jokes", "riddle", "riddles", "recipe", "recipes", "translate", "translation",
];
export const TASK_OFF_PHRASES = [
  "write a poem", "write me a poem", "write a story", "write an essay", "my essay", "history essay", "tell me a joke", "a joke about",
  "recipe for", "how to cook", "how to bake", "do my homework", "solve this equation", "write code", "write a function", "fix my code",
];

/** Facets of a vehicle (or part) that a question can be about. Used to interpret short follow-ups
 *  ("Highway?", "What is the pricing?"), to ask specific clarifying questions, and to decide which
 *  verified data sources apply. Ordered: the first match wins. Patterns run on normalized text. */
export type AspectId =
  | "fuel_economy" | "ev_range" | "fuel_range" | "recalls" | "warranty" | "insurance" | "value" | "financing" | "running_costs"
  | "repairs" | "price" | "reliability" | "practicality" | "safety" | "towing" | "performance" | "specs" | "legal" | "cost";

export const ASPECTS: { id: AspectId; label: string; re: RegExp; clarify: string }[] = [
  {
    id: "fuel_economy",
    label: "fuel economy",
    re: /\b(?:mpge?|fuel (?:economy|efficiency|consumption|costs?|bill)|gas (?:mileage|money|costs?|bill)|miles per gallon|l\/100 ?km|km\/l|(?:city|highway|combined) (?:mpg|mileage|rating|economy)|(?:need|needs|take|takes|run on|runs on|use|uses|require|requires) (?:premium|regular|diesel|e85)|premium (?:fuel|gas|unleaded)|octane|cost to fill|thirsty|guzzl\w*)\b/,
    clarify: "Which vehicle's fuel economy do you mean? Include the year, make and model (and the engine if it had several).",
  },
  {
    id: "ev_range",
    label: "EV range & charging",
    re: /\b(?:ev range|battery range|electric range|range anxiety|charging|chargers?|recharg\w*|how long (?:does it take )?to charge|charge (?:time|rate|it)|kwh|battery (?:degradation|health|life|replacement)|miles of range)\b/,
    clarify: "Which EV do you mean? Include the year, make and model (battery size helps if it had several).",
  },
  {
    id: "fuel_range",
    label: "driving range per tank",
    re: /\b(?:(?:miles|km|range) (?:on|per|from) a (?:full )?tank|tank range|fuel tank|tank (?:size|capacity)|how far (?:can|does|will) (?:it|they|one) go)\b/,
    clarify: "Which vehicle do you mean? Range per tank depends on its fuel economy and tank size, so include the year, make and model.",
  },
  { id: "recalls", label: "recalls", re: /\brecall(?:s|ed)?\b/, clarify: "Which vehicle do you want recall information for? Include the year, make and model." },
  {
    id: "warranty",
    label: "warranty",
    re: /\b(?:warrant(?:y|ies)|cpo|certified pre-?owned|powertrain coverage|extended coverage)\b/,
    clarify: "Which vehicle's warranty do you mean? Include the year, make and model, and whether it's new or used.",
  },
  {
    id: "insurance",
    label: "insurance",
    re: /\b(?:insur\w*|(?:young|younger|new|teen|first[- ]time) drivers?)\b/,
    clarify: "Which vehicle do you want insurance considerations for? The year, make and model are enough — no personal details needed.",
  },
  {
    id: "value",
    label: "depreciation & resale value",
    re: /\b(?:depreciat\w*|resale|hold (?:its|their|it's) value|holds? (?:its |their )?value|residual value|trade-?in value)\b/,
    clarify: "Which vehicle's resale value do you mean? Include the year, make and model.",
  },
  {
    id: "financing",
    label: "financing & leasing",
    re: /\b(?:financ\w*|loan|loans|interest rates?|apr|lease|leasing|down payment|monthly payments?)\b/,
    clarify: "Which vehicle or deal do you mean? Tell me the vehicle and whether you're financing, leasing or paying cash.",
  },
  {
    id: "running_costs",
    label: "maintenance & running costs",
    re: /\b(?:maintenance|maintain|servic(?:e|es|ing)|upkeep|oil changes?|running costs?|costs? to (?:own|run|maintain|service)|ownership costs?|cost of ownership|cheap(?:er|est)? to (?:own|run|maintain|service|keep))\b/,
    clarify: "Which vehicle's maintenance costs do you mean? Include the year, make and model.",
  },
  {
    id: "repairs",
    label: "repairs & parts",
    re: /\b(?:repairs?|replace|replacing|replacement|rebuild|rebuilt|parts? (?:costs?|prices?|availability)|(?:are|is) (?:the )?parts?|parts (?:are|hard|easy|expensive|cheap)|labou?r (?:costs?|rates?)|water pump|timing (?:chain|belt)|head gasket|clutch job|new engine|replacement engine)\b/,
    clarify: "Which vehicle or part do you mean? Include the year, make and model, and the repair if you know it.",
  },
  {
    id: "price",
    label: "purchase price",
    re: /\b(?:price|prices|pricing|priced|msrp|sticker|asking price|market value|going rate|out the door|dealer markup|cost new|used (?:prices?|market|ones?|examples?)|how much (?:are|is|was|were|do|does) (?:they|it|one|a|an|the)\b[^?]*\b(?:used|new|go for|sell for)|how much for)\b/,
    clarify: "Which vehicle do you want pricing for — and new or used? Include the year, make and model.",
  },
  {
    id: "reliability",
    label: "reliability",
    re: /\b(?:reliab\w*|unreliable|problems?|issues?|break(?:s| down)?|breakdowns?|failures?|fails?|years? to avoid|avoid (?:which )?years?|which years|lemon|durab\w*|longevity|lasts? long|high[- ]mileage|common faults?)\b/,
    clarify: "Which vehicle, engine or component do you mean — for example a specific model or a turbocharger?",
  },
  {
    id: "practicality",
    label: "practicality & comfort",
    re: /\b(?:daily(?: driver| drive)?|practical\w*|comfort\w*|ride (?:quality|comfort)|cargo|trunk|boot space|rear seats?|back seats?|legroom|headroom|family car|commut\w*|interior space|road trips?)\b/,
    clarify: "Which vehicle do you mean? Include the year, make and model.",
  },
  {
    id: "safety",
    label: "safety",
    re: /\b(?:safety (?:ratings?|features?|scores?)|crash[- ]tests?|crash ratings?|iihs|ncap|safest|safe (?:car|vehicle|suv|choice)|driver[- ]assist\w*|adas)\b/,
    clarify: "Which vehicle's safety do you mean? Include the year, make and model.",
  },
  { id: "towing", label: "towing & payload", re: /\b(?:tow(?:ing)?|payload|hitch|trailer)\b/, clarify: "Which vehicle's towing capacity do you mean? Include the year, make, model and engine." },
  {
    id: "performance",
    label: "performance",
    re: /\b(?:0-60|0-100|quarter-mile|acceleration|top speed|how fast|faster|quicker|lap times?|launch(?:es)?)\b/,
    clarify: "Which vehicle do you mean? Name the model, or load one in Manual Setup.",
  },
  {
    id: "specs",
    label: "specifications & trims",
    re: /\b(?:trims?|engine options?|which engines?|what engines?|dimensions?|features|options|generations?|specs|specifications?|come (?:in|with)|available (?:in|with)|models? (?:are there|were there|had|have))\b/,
    clarify: "Which manufacturer or model line do you mean?",
  },
  {
    id: "legal",
    label: "legality & emissions rules",
    re: /\b(?:legal|illegal|street[- ]legal|emissions? (?:laws?|rules|regulations|tests?|testing)|smog (?:check|test|legal)|carb[- ](?:legal|compliant)|regulations?)\b/,
    clarify: "Which vehicle, part or modification do you mean, and in which country or state?",
  },
  {
    id: "cost",
    label: "cost",
    // "How much does it cost?" — not "How much does weight affect acceleration?" or "how much power".
    re: /\b(?:how much (?:is|are|was|were|does|do|did|would|will|for|to|money)\b(?![^?]*\b(?:affect|affects|impact|matter|help|change|improve|add|reduce|increase|weigh|power|torque|boost|horsepower|hp|grip|faster|slower|range|weight|psi)\b)|cost|costs|costly|expensive|cheap|cheaper|cheapest|pricey|afford\w*)\b/,
    clarify: "Do you mean the price of a vehicle, a part or repair, or a modification? Name it and I'll take it from there.",
  },
];

/** Trim designations that follow a model name ("F-Type R", "C43 AMG"). */
export const TRIM_TOKENS = ["r", "s", "svr", "sv", "gt", "gts", "rs", "amg", "st", "si", "ss", "srt", "trd", "sport", "type-r", "gti", "xdrive", "4matic", "quattro", "hybrid"];

/** Messages answered locally without any AI request. */
export const SMALL_TALK = /^(?:hi|hello|hey|hiya|yo|good (?:morning|afternoon|evening)|thanks?(?: you)?(?: so much| a lot)?|thank you(?: very much)?|thx|ty|cheers|ok(?:ay)?|cool|great|nice|awesome|got it|perfect|sounds good|bye|goodbye|see you)[!. ]*$/i;

/**
 * Names that are both vehicles and everyday words. Alone they are ambiguous: the gate asks which
 * one is meant (locally) unless the sentence or the conversation already establishes the car.
 */
export const AMBIGUOUS_NAMES: Record<string, { car: string; make: string; other: string }> = {
  jaguar: { car: "Jaguar cars", make: "Jaguar", other: "the animal" },
  mustang: { car: "the Ford Mustang", make: "Ford Mustang", other: "the horse" },
  lincoln: { car: "Lincoln cars", make: "Lincoln", other: "Abraham Lincoln" },
  mercury: { car: "Mercury cars", make: "Mercury", other: "the planet or the element" },
  saturn: { car: "Saturn cars", make: "Saturn", other: "the planet" },
  genesis: { car: "Genesis cars", make: "Genesis", other: "something else named Genesis" },
  lotus: { car: "Lotus cars", make: "Lotus", other: "the flower" },
  ram: { car: "Ram trucks", make: "Ram", other: "the animal" },
  beetle: { car: "the Volkswagen Beetle", make: "Volkswagen Beetle", other: "the insect" },
  viper: { car: "the Dodge Viper", make: "Dodge Viper", other: "the snake" },
  eclipse: { car: "the Mitsubishi Eclipse", make: "Mitsubishi Eclipse", other: "an eclipse" },
  bronco: { car: "the Ford Bronco", make: "Ford Bronco", other: "the horse" },
  raptor: { car: "the Ford Raptor", make: "Ford Raptor", other: "the dinosaur or bird" },
  impala: { car: "the Chevrolet Impala", make: "Chevrolet Impala", other: "the antelope" },
  cobra: { car: "the Shelby Cobra", make: "Shelby Cobra", other: "the snake" },
  puma: { car: "the Ford Puma", make: "Ford Puma", other: "the animal" },
};

/** Display names for manufacturers (keys are lowercase tokens). */
export const MAKE_NAMES: Record<string, string> = {
  acura: "Acura", alfa: "Alfa Romeo", aston: "Aston Martin", audi: "Audi", bentley: "Bentley", bmw: "BMW", bugatti: "Bugatti", buick: "Buick",
  byd: "BYD", cadillac: "Cadillac", chevrolet: "Chevrolet", chevy: "Chevrolet", chrysler: "Chrysler", citroen: "Citroen", cupra: "Cupra",
  dacia: "Dacia", datsun: "Datsun", dodge: "Dodge", ferrari: "Ferrari", fiat: "Fiat", fisker: "Fisker", ford: "Ford", gmc: "GMC", honda: "Honda",
  hummer: "Hummer", hyundai: "Hyundai", infiniti: "Infiniti", isuzu: "Isuzu", jeep: "Jeep", kia: "Kia", koenigsegg: "Koenigsegg",
  lamborghini: "Lamborghini", lambo: "Lamborghini", lancia: "Lancia", landrover: "Land Rover", lexus: "Lexus", lucid: "Lucid", maserati: "Maserati",
  maybach: "Maybach", mazda: "Mazda", mclaren: "McLaren", mercedes: "Mercedes-Benz", benz: "Mercedes-Benz", "mercedes-benz": "Mercedes-Benz",
  merc: "Mercedes-Benz", mini: "Mini", mitsubishi: "Mitsubishi", nissan: "Nissan", oldsmobile: "Oldsmobile", opel: "Opel", pagani: "Pagani",
  peugeot: "Peugeot", plymouth: "Plymouth", polestar: "Polestar", pontiac: "Pontiac", porsche: "Porsche", renault: "Renault", rivian: "Rivian",
  rolls: "Rolls-Royce", saab: "Saab", scion: "Scion", skoda: "Skoda", subaru: "Subaru", suzuki: "Suzuki", tesla: "Tesla", toyota: "Toyota",
  vauxhall: "Vauxhall", volkswagen: "Volkswagen", vw: "Volkswagen", volvo: "Volvo", yugo: "Yugo",
};

/** Engine families and induction (subject tracking). */
export const ENGINE_TERMS: [RegExp, string][] = [
  [/\b(?:v-?8|v8s)\b/, "V8"],
  [/\b(?:v-?6|v6s)\b/, "V6"],
  [/\bv-?10\b/, "V10"],
  [/\b(?:v-?12|w12)\b/, "V12"],
  [/\b(?:i-?6|inline[- ]?six|straight[- ]?six)\b/, "inline-six"],
  [/\b(?:i-?4|inline[- ]?four|four[- ]cylinder)\b/, "four-cylinder"],
  [/\b(?:flat[- ]?six|boxer)\b/, "flat/boxer"],
  [/\b(?:rotary|wankel)\b/, "rotary"],
  [/\bsupercharg\w*/, "supercharged"],
  [/\b(?:twin[- ]?turbo|bi-?turbo)\w*/, "twin-turbo"],
  [/\bturbocharged\b|\bturbo engines?\b/, "turbocharged"],
  [/\bnaturally aspirated\b/, "naturally aspirated"],
  [/\bdiesel\b/, "diesel"],
  [/\bhybrids?\b/, "hybrid"],
  [/\b(?:ev|evs|electric (?:car|vehicle|motor)s?)\b/, "electric"],
  [/\b(?:hemi|coyote|ecoboost|ls[1-9]|lt[1-5]|2jz|rb26|b58|n55|s55|s58|m156|m177|m178|k20|k24|ej25\d?|fa20|vr38)\b/, "engine code"],
];

/** Components and systems (subject tracking). */
export const COMPONENT_TERMS: [RegExp, string][] = [
  [/\bturbo ?lag\b/, "turbo lag"],
  [/\bturbo(?:charger)?s?\b/, "turbochargers"],
  [/\bsupercharger/, "superchargers"],
  [/\bintercooler/, "intercoolers"],
  [/\bwastegates?\b/, "wastegates"],
  [/\b(?:blow[- ]?off valves?|bovs?|diverter valves?)\b/, "blow-off valves"],
  [/\bdownpipe/, "downpipes"],
  [/\bexhaust/, "exhaust systems"],
  [/\b(?:intake|cold air)\b/, "intakes"],
  [/\bspark plugs?\b/, "spark plugs"],
  [/\b(?:ignition coils?|coil packs?)\b/, "ignition coils"],
  [/\bmisfir/, "engine misfires"],
  [/\b(?:knock|detonation)\b/, "engine knock"],
  [/\b(?:ecu|tune|tuning|remap)\b/, "engine tuning"],
  [/\b(?:dct|dual[- ]clutch|dsg|pdk)\b/, "dual-clutch transmissions"],
  [/\bcvt\b/, "CVTs"],
  [/\btorque converter/, "torque converters"],
  [/\b(?:transmission|gearbox)/, "transmissions"],
  [/\b(?:lsd|limited[- ]slip|differential)/, "differentials"],
  [/\b(?:awd|rwd|fwd|4wd|all[- ]wheel drive|rear[- ]wheel drive)\b/, "drivetrain layouts"],
  [/\b(?:suspension|coilovers?|springs|dampers|shocks|sway ?bars?|camber|alignment)\b/, "suspension & handling"],
  [/\b(?:brakes?|rotors?|calipers?|brake pads)\b/, "brakes"],
  [/\b(?:tires?|tyres?|grip|traction)\b/, "tires & traction"],
  [/\b(?:oil change|engine oil|oil)\b/, "engine oil & maintenance"],
  [/\b(?:check engine|engine light|obd|dtc|trouble code)/, "check-engine diagnostics"],
  [/\b(?:batter(?:y|ies)|alternator)\b/, "batteries & charging"],
  [/\b(?:aero|downforce|drag coefficient|spoiler|wing)\b/, "aerodynamics"],
  [/\b(?:0-60|0-100|quarter-mile|acceleration)\b/, "acceleration"],
];

/** Attempts to change the assistant's role or extract its instructions. */
export const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(?:instructions?|rules?|prompt|guidelines?|restrictions?|constraints?|system|programming|automotive)\b/i,
  /\bpretend\b[^.?!]{0,30}\b(?:you(?:'re| are)?|to be)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:act|behave|respond|roleplay|role-play) as (?:an? )?(?:unrestricted|general|different|new|uncensored|jailbroken|evil|dan)\b/i,
  /\b(?:jailbreak|jail-break|dan mode|developer mode|god mode|unrestricted (?:mode|chatbot|assistant|ai)|no restrictions|without restrictions)\b/i,
  /\b(?:system prompt|your (?:instructions|rules|prompt)|hidden instructions|initial prompt)\b/i,
  /\bnew (?:instructions|rules|persona)\b/i,
  /\b(?:fake |following |this )?(?:system|developer) (?:message|prompt|instructions?|role)\b/i,
  /\byou(?:'re| are) (?:no longer|not) (?:an? )?(?:automotive|car)\b/i,
  /\bpretend\b[^.?!]{0,40}\b(?:unrestricted|general[- ]purpose|chatbot|no rules)\b/i,
  /^\s*(?:system|developer|assistant)\s*[:>]/i,
];
