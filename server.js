const express = require('express');
const http = require('http');
const fs = require('fs');
const e = require('express');

const app = express();
const server = http.createServer(app);

// Synchonously read the contents of db.json and save to a global variable named db
let db = {};
db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
// if db does not contain a key named "dbIsValid", then throw an error and exit
if (!db.dbIsValid) {
    throw new Error('Invalid db.json file');
}
console.log('db.json has been read and parsed');
if (!db.idCounter) {
    db.idCounter = {};
}
if (!db.events) {
    db.events = [];
}

let isSaving = false;
let isDirty = false;
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000; // 1 second

function saveDb(retries = 0) {
    if (isSaving) {
        isDirty = true;
        return;
    }
    isSaving = true;
    fs.writeFile('db.temp.json', JSON.stringify(db, null, 2), (err) => {
        if (err) {
            console.error('Error writing db.temp.json:', err);
            isSaving = false;
            throw new Error('Error writing db.temp.json');
        } else {
            fs.rename('db.temp.json', 'db.json', (err) => {
                isSaving = false;
                if (err) {
                    console.error('Error renaming temp db.json:', err);
                    if (retries < MAX_RETRIES) {
                        console.log(`Retrying rename in ${RETRY_DELAY}ms... (${retries + 1}/${MAX_RETRIES})`);
                        setTimeout(() => saveDb(retries + 1), RETRY_DELAY);
                    } else {
                        throw new Error('Error renaming temp db.json after multiple attempts');
                    }
                } else {
                    console.log('db.json has been written');
                    if (isDirty) {
                        isDirty = false;
                        saveDb();
                    }
                }
            });
        }
    });
}

function cleanDbOnStartup() {
    console.log('running cleanDbOnStartup');
    db.events.forEach(event => {
        // remove the 'modified' property from each event
        delete event.modified;
    });
    saveDb();
    console.log('cleanDbOnStartup has finished');
}
// cleanDbOnStartup();

function getNextId(prefix) {
    if (!db.idCounter[prefix]) {
        db.idCounter[prefix] = 1;
    }
    return prefix + db.idCounter[prefix]++;
    // relies on calling function to save db
}

// POST /api/event
app.post('/api/event', express.json(), (req, res) => {
    const newEvent = req.body;
    if (newEvent.id) {
        res.status(400).json({ error: 'Event should not have an id' });
        return;
    }
    if (!newEvent.tags || !Array.isArray(newEvent.tags)) {
        res.status(400).json({ error: 'Event must have a tags array' });
        return;
    }
    newEvent.id = getNextId('event');
    newEvent.tags = extrapolateTags(newEvent.tags);
    newEvent.created = new Date().toISOString();
    db.events.unshift(newEvent);
    saveDb();
    res.json(newEvent);
});

// PUT /api/event/:id
app.put('/api/event/:id', express.json(), (req, res) => {
    const idFromUrl = req.params.id;
    const eventIndex = db.events.findIndex(event => event.id === idFromUrl);
    if (eventIndex === -1) {
        res.status(404).json({ error: 'Event not found' });
        return;
    }
    const oldEvent = db.events[eventIndex];
    const newEvent = req.body;
    if (newEvent.id && newEvent.id !== idFromUrl) {
        res.status(400).json({ error: 'Event id cannot be changed' });
        return;
    }
    if (newEvent.created && newEvent.created !== oldEvent.created) {
        res.status(400).json({ error: 'Event created date cannot be changed' });
        return;
    }
    if (!newEvent.tags || !Array.isArray(newEvent.tags)) {
        res.status(400).json({ error: 'Event must have a tags array' });
        return;
    }
    newEvent.created = oldEvent.created;
    db.events[eventIndex] = newEvent;
    saveDb();
    res.json(newEvent);
});

// DELETE /api/event/:id
app.delete('/api/event/:id', (req, res) => {
    const id = req.params.id;
    const eventIndex = db.events.findIndex(event => event.id === id);
    if (eventIndex === -1) {
        res.status(404).json({ error: 'Event not found' });
        return;
    }
    db.events.splice(eventIndex, 1);
    saveDb();
    res.json({ success: true });
});

// GET /api/events
app.get('/api/events', (req, res) => {
    // return a copy of the events array
    // if "recent_count=X" query parameter is provided, return only the X most recent events
    const recentCount = parseInt(req.query.recent_count);
    if (recentCount) {
        res.json(db.events.slice(0, recentCount));
    } else {
        res.json(db.events);
    }
});

// GET /api/tagautocomplete
app.get('/api/tagautocomplete', (req, res) => {
    // accepts a query parameter "q" and returns a list of tags that start with that query
    const query = req.query.q;
    if (!query) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
    }
    const tagSet = new Set();
    db.events.forEach(event => {
        event.tags.forEach(tag => {
            if (tag.startsWith(query)) {
                tagSet.add(tag);
            }
        });
    });
    // also get tags that contain the query
    db.events.forEach(event => {
        event.tags.forEach(tag => {
            if (tag.includes(query)) {
                tagSet.add(tag);
            }
        });
    });
    res.json(Array.from(tagSet));
});

// Daily required tagsets are sets of tags that are generally mutually exclusive; each day should have one tag from each set
// For example: ['workday', 'weekend', 'holiday', 'vacation', 'sickday'] or ['pills', 'pills skipped']
// Once a tagset is used for a day, it should not be suggested again for that day
// If a tagset has not yet been used on a day, it should be suggested with very high priority
// It is considered a new day (subjectively speaking) for the starting at 11:00am UTC

function getSubjectiveDayFromDate(date) {
    // returns an integer representing the local subjective day
    // the integer is relative to an arbitrary start date--it should only be used for comparison purposes
    // the arbitrary start date is 11:00am UTC on 2024-11-01
    // it is considered a new subjective day starting at 11:00am UTC
    // Examples:
    // 2024-11-01T11:00:00Z => 0
    // 2024-11-02T10:59:59Z => 0
    // 2024-11-02T11:00:00Z => 1
    // 2024-11-03T10:59:59Z => 1

    const arbitraryStartDate = new Date('2024-11-01T11:00:00Z');
    const diff = date - arbitraryStartDate;
    const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
    return diffDays;
}

// The following is a list of daily required tagsets
const dailyRequiredTagsets = [
    ['workday', 'weekend', 'holiday', 'vacation', 'sickday', 'weirdday'],
    ['pills', 'pills skipped', 'pills SPECIAL'],
    ['olive no special meds', 'olive special meds', 'olive clavamox'],
];
const flatListOfDailyRequiredTags = flattenTagsets(dailyRequiredTagsets);
// Tagsets are not treated specially in the db, each tag is applied like any other tag

function getRemainingDailyRequiredTagsetsForADay(date) {
    // returns an array of daily required tagsets that have not yet been used for the given date
    const subjectiveDay = getSubjectiveDayFromDate(date);
    // get an array of all events for the given date (since the db is sorted by most recent first, we can stop when we reach the next day)
    const eventsForDate = [];
    for (let i = 0; i < db.events.length; i++) {
        const event = db.events[i];
        if (getSubjectiveDayFromDate(new Date(event.created)) === subjectiveDay) {
            eventsForDate.push(event);
        } else {
            break;
        }
    }
    // get a set of all tags used on the given date
    const tagsUsed = new Set();
    eventsForDate.forEach(event => event.tags.forEach(tag => tagsUsed.add(tag)));
    // get the daily required tagsets that have not yet been used
    const remainingTagsets = dailyRequiredTagsets.filter(tagset => !tagset.some(tag => tagsUsed.has(tag)));
    return remainingTagsets;
}

class CachedTagInformationForDate {
    constructor(date) {
        this.date = date;
        this.remainingRequiredDailyTagSets = null;
        this.remainingRequiredDailyTagsFlatList = null;
    }
    getRemainingRequiredDailyTagsets() {
        if (!this.remainingRequiredDailyTagSets) {
            this.remainingRequiredDailyTagSets = getRemainingDailyRequiredTagsetsForADay(this.date);
        }
        return this.remainingRequiredDailyTagSets;
    }
    getRemainingRequiredDailyTagsetsFlatList() {
        if (!this.remainingRequiredDailyTagsFlatList) {
            this.remainingRequiredDailyTagsFlatList = flattenTagsets(this.getRemainingRequiredDailyTagsets());
        }
        return this.remainingRequiredDailyTagsFlatList;
    }
    isTagPossiblyAppropriateForDate(tag) {
        // this helps to prevent suggesting tags that are part of a required tagset that has already been used for the given date
        if (flatListOfDailyRequiredTags.includes(tag)) {
            // the tag is part of a required tagset, so it should only be considered appropriate if it is part of a tagset that has not yet been used for the given date
            return this.getRemainingRequiredDailyTagsetsFlatList().includes(tag);
        } else {
            // the tag is not part of a required tagset, so it might be appropriate
            return true;
        }
    }
}

function flattenTagsets(tagsets) {
    // returns a flat array of tags from the given array of tagsets
    const tags = new Set();
    tagsets.forEach(tagset => tagset.forEach(tag => tags.add(tag)));
    return Array.from(tags);
}

// POST /api/gettagsuggestions
app.post('/api/gettagsuggestions', express.json(), (req, res) => {
    // accepts a list of tags, searches for events that contain all/some of those tags, and returns a list of tags that are used in those events
    // if no tags are provided, returns the most used 'first' tags
    // if daily required tagsets have not yet been used for the day, they are returned with special priority
    // returns an object with properties:
    // required: an array of tags from tagsets that have not yet been used today
    // best: an array of tags that are a good match for the provided tags (they have been used in events that contain ALL of the provided tags)
    // other: all other possible tags, sorted first by how well they match the provided tags, then by how often they have been used, and finally by how recently they were used (happens automatically since the db is sorted by most recent first)
    const tagsAlreadyChosen = req.body;
    // TODO: modify this function to accept a date parameter and use that date to determine the daily required tagsets, rather than the current date; we'll need to modify the API call so that body is an object with tagsAlreadyChosen and date properties
    if (!Array.isArray(tagsAlreadyChosen)) {
        res.status(400).json({ error: 'Request body must be an array of tags' });
        return;
    }
    if (tagsAlreadyChosen.length === 0) {
        const cachedTagInformation = new CachedTagInformationForDate(new Date());
        const remainingRequiredDailyTags = cachedTagInformation.getRemainingRequiredDailyTagsetsFlatList();
        const mostUsedFirstTags = getMostUsedFirstTags().filter(tag => !remainingRequiredDailyTags.includes(tag) && cachedTagInformation.isTagPossiblyAppropriateForDate(tag));
        const otherTags = getAllTags().filter(tag => !mostUsedFirstTags.includes(tag) && !remainingRequiredDailyTags.includes(tag) && cachedTagInformation.isTagPossiblyAppropriateForDate(tag));
        res.json({ required: remainingRequiredDailyTags, best: mostUsedFirstTags, other: otherTags });
    } else {
        const byNumberOfTagsInCommonWithTagsAlreadyChosen = {}; // key is number of tags in common, value is another object
        // the inner object has a key that is the tag and a value that is the number of times that tag has been used in events that have the same number of tags in common with tagsAlreadyChosen
        db.events.forEach(event => {
            const tagsInCommon = event.tags.filter(tag => tagsAlreadyChosen.includes(tag));
            const countOfTagsInCommon = tagsInCommon.length;
            if (!byNumberOfTagsInCommonWithTagsAlreadyChosen[countOfTagsInCommon]) {
                byNumberOfTagsInCommonWithTagsAlreadyChosen[countOfTagsInCommon] = {};
            }
            event.tags.forEach(tag => {
                if (!tagsAlreadyChosen.includes(tag)) {
                    if (!byNumberOfTagsInCommonWithTagsAlreadyChosen[countOfTagsInCommon][tag]) {
                        byNumberOfTagsInCommonWithTagsAlreadyChosen[countOfTagsInCommon][tag] = 0;
                    }
                    byNumberOfTagsInCommonWithTagsAlreadyChosen[countOfTagsInCommon][tag]++;
                }
            });
        });
        const tagSetBest = new Set();
        const tagSet = new Set();
        for (let i = tagsAlreadyChosen.length; i >= 0; i--) {
            if (byNumberOfTagsInCommonWithTagsAlreadyChosen[i]) {
                const tagsSortedByUsage = Object.keys(byNumberOfTagsInCommonWithTagsAlreadyChosen[i]).sort((a, b) => byNumberOfTagsInCommonWithTagsAlreadyChosen[i][b] - byNumberOfTagsInCommonWithTagsAlreadyChosen[i][a]);
                tagsSortedByUsage.forEach(tag => {
                    if (i === tagsAlreadyChosen.length) {
                        tagSetBest.add(tag);
                    } else {
                        if (!tagSetBest.has(tag)) {
                            tagSet.add(tag);
                        }
                    }
                });
            }
        }

        res.json({ best: Array.from(tagSetBest), other: Array.from(tagSet) });
    }
});

function getMostUsedFirstTags() {
    const tagCount = {};
    db.events.forEach(event => {
        const firstTag = event.tags[0];
        if (!tagCount[firstTag]) {
            tagCount[firstTag] = 0;
        }
        tagCount[firstTag]++;
    });
    const tags = Object.keys(tagCount);
    tags.sort((a, b) => tagCount[b] - tagCount[a]);
    return tags;
}

function getAllTags() {
    const tagSet = new Set();
    db.events.forEach(event => {
        event.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet);
}

function extrapolateTags(tagsList) {
    // only partially implemented
    // this function should return a list of tags that includes the original tags, as well as any tags that are implied by the original tags
    // this will be used eventually to enhance reporting and/or retrofitting of tags
    // it is currently referenced in the /api/reporting/events route
    // it is also referenced in the /api/event POST route

    // if any of the tags start with "olive " and the event does not have the "olive" tag, add the "olive" tag as the first tag
    if (tagsList.some(tag => tag.startsWith('olive ')) && !tagsList.includes('olive')) {
        tagsList = ['olive', ...tagsList];
    }

    return tagsList;
}

function convertTagsArrayToObject(tagsList) {
    const tags = {};
    tagsList.forEach(tag => tags[tag] = 1);
    return tags;
}

// GET /api/reporting/events
app.get('/api/reporting/events', (req, res) => {
    // returns an object optimized for reporting purposes
    const report = {};
    // create a list of all events and extrapolate tags
    report.events = db.events.map(event => {
        const extrapolatedTags = extrapolateTags(event.tags);
        const objectifiedTags = convertTagsArrayToObject(extrapolatedTags);
        return { ...event, tags: objectifiedTags };
    });
    // create a list of all tags used in events
    const tags = new Set();
    db.events.forEach(event => extrapolateTags(event.tags).forEach(tag => tags.add(tag)));
    report.tags = Array.from(tags);
    // include misc stats
    report.totalEvents = report.events.length;
    report.totalTags = report.tags.size;
    report.dateGenerated = new Date().toISOString();
    res.json(report);
});

// GET /api/reporting/events_olive
app.get('/api/reporting/events_olive', (req, res) => {
    // returns an object optimized for reporting purposes
    const report = {};
    // create a list of all events that contain the tag 'olive' and extrapolate tags
    report.events = db.events
        .filter(event => event.tags.includes('olive'))
        .map(event => {
            const extrapolatedTags = extrapolateTags(event.tags);
            const objectifiedTags = convertTagsArrayToObject(extrapolatedTags);
            return { ...event, tags: objectifiedTags };
        });
    // create a list of all tags used in events
    const tags = new Set();
    db.events.filter(event => event.tags.includes('olive')).forEach(event => extrapolateTags(event.tags).forEach(tag => tags.add(tag)));
    report.tags = Array.from(tags);
    // include misc stats
    report.totalEvents = report.events.length;
    report.totalTags = report.tags.size;
    report.dateGenerated = new Date().toISOString();
    res.json(report);
});

// GET /api/reporting/events_non_olive
app.get('/api/reporting/events_non_olive', (req, res) => {
    // returns an object optimized for reporting purposes
    const report = {};
    // create a list of all events that do not contain the tag 'olive' and extrapolate tags
    report.events = db.events
        .filter(event => !event.tags.includes('olive'))
        .map(event => {
            const extrapolatedTags = extrapolateTags(event.tags);
            const objectifiedTags = convertTagsArrayToObject(extrapolatedTags);
            return { ...event, tags: objectifiedTags };
        });
    // create a list of all tags used in events
    const tags = new Set();
    db.events.filter(event => !event.tags.includes('olive')).forEach(event => extrapolateTags(event.tags).forEach(tag => tags.add(tag)));
    report.tags = Array.from(tags);
    // include misc stats
    report.totalEvents = report.events.length;
    report.totalTags = report.tags.size;
    report.dateGenerated = new Date().toISOString();
    res.json(report);
});

app.use(express.static('public'));

server.listen(3031, () => {
    console.log('Server started on http://localhost:3031/pooptrac.html');
});
