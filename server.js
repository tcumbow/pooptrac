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
    sendRefreshSignal();
}

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
    newEvent.created = new Date().toISOString();
    newEvent.modified = newEvent.created;
    db.events.unshift(newEvent);
    saveDb();
    res.json(newEvent);
});

// PUT /api/event/:id
app.put('/api/event/:id', express.json(), (req, res) => {
    const id = req.params.id;
    const eventIndex = db.events.findIndex(event => event.id === id);
    if (eventIndex === -1) {
        res.status(404).json({ error: 'Event not found' });
        return;
    }
    const event = db.events[eventIndex];
    const newEvent = req.body;
    if (newEvent.id && newEvent.id !== id) {
        res.status(400).json({ error: 'Event id cannot be changed' });
        return;
    }
    if (newEvent.created) {
        res.status(400).json({ error: 'Event created date cannot be changed' });
        return;
    }
    if (!newEvent.tags || !Array.isArray(newEvent.tags)) {
        res.status(400).json({ error: 'Event must have a tags array' });
        return;
    }
    newEvent.id = id;
    newEvent.created = event.created;
    newEvent.modified = new Date().toISOString();
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
        res.json(db.events.slice(recentCount));
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
    res.json(Array.from(tagSet));
});

// POST /api/gettagsuggestions
app.post('/api/gettagsuggestions', express.json(), (req, res) => {
    // accepts a list of tags, searches for events that contain all of those tags, and returns a list of tags that are used in those events
    const tagsAlreadyChosen = req.body;
    if (!Array.isArray(tagsAlreadyChosen)) {
        res.status(400).json({ error: 'Request body must be an array of tags' });
        return;
    }
    const tagSet = new Set();
    db.events.forEach(event => {
        if (tagsAlreadyChosen.every(tag => event.tags.includes(tag))) {
            event.tags.forEach(tag => {
                if (!tagsAlreadyChosen.includes(tag)) {
                    tagSet.add(tag);
                }
            });
        }
    });
    res.json(Array.from(tagSet));
});

app.use(express.static('public'));

server.listen(3031, () => {
    console.log('Server started on http://localhost:3031');
});

// the following code can be used on the client side to call these APIs
// async function postEvent(event) {
//     const response = await fetch('/api/event', {
//         method: 'POST',
//         headers: {
//             'Content-Type': 'application/json'
//         },
//         body: JSON.stringify(event)
//     });
//     return await response.json();
// }

// async function putEvent(id, event) {
//     const response = await fetch(`/api/event/${id}`, {
//         method: 'PUT',
//         headers: {
//             'Content-Type': 'application/json'
//         },
//         body: JSON.stringify(event)
//     });
//     return await response.json();
// }

// async function deleteEvent(id) {
//     const response = await fetch(`/api/event/${id}`, {
//         method: 'DELETE'
//     });
//     return await response.json();
// }

// async function getEvents(recentCount) { // returns an array of events
//     const response = await fetch(`/api/events?recent_count=${recentCount}`);
//     return await response.json();
// }

// async function getTagAutocomplete(query) { // returns an array of tags
//     const response = await fetch(`/api/tagautocomplete?q=${query}`);
//     return await response.json();
// }

// async function getTagSuggestions(tagsAlreadyChosen) { // returns an array of tags
//     const response = await fetch('/api/gettagsuggestions', {
//         method: 'POST',
//         headers: {
//             'Content-Type': 'application/json'
//         },
//         body: JSON.stringify(tagsAlreadyChosen)
//     });
//     return await response.json();
// }
