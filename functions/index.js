const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue} = require('firebase-admin/firestore');
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const app = initializeApp();

const functions = require('firebase-functions');
const nodeMailer = require('nodemailer');
const emailConfig = require('./emailConfig.json');

const {getMessaging} = require("firebase-admin/messaging");
const messaging = getMessaging(app);

const FIRESTORE = getFirestore();
const USERS = FIRESTORE.collection("users");
const CIRCLES = FIRESTORE.collection("circles");
const ACCOUNTS = FIRESTORE.collection("accounts");
const TRANSACTIONS = FIRESTORE.collection("transactions");
const NOTIFICATIONS = FIRESTORE.collection("notifications");

exports.userCreated = functions.auth
    .user().onCreate((user) => {
        return NOTIFICATIONS.where("contact", "==", user.email.toLowerCase()).get().then(snapshot => {

            const batch = FIRESTORE.batch();
            snapshot.docs.forEach(doc =>
                batch.update(doc.ref, {
                    users: FieldValue.arrayUnion(user.uid),
                    [`access${user.uid}`]: 4,
                    to: {id: user.uid, displayName: user.displayName, photoURL: user.photoURL, email: user.email.toLowerCase()}
                }));

            batch.set(USERS.doc(user.uid), {
                id: user.uid,
                email: user.email.toLowerCase(),
                displayName: user.displayName,
                photoURL: user.photoURL,
                created: FieldValue.serverTimestamp(),
                user: user.uid,
                type: "user",
            });

            return batch.commit();
        })
    });

exports.accountUpdated = functions.firestore
    .document('accounts/{id}')
    .onUpdate((snap, context) => {

        const old = snap.before.data();
        const now = snap.after.data();

        // Check if users added or removed
        const removed = old.users.filter(x => !now.users.includes(x));

        if (removed.length > 0 || old.color !== now.color)
            return TRANSACTIONS.where("account", "==", context.params.id).get().then(snapshot => {
                return new Promise(resolve => {
                    const docs = [];
                    snapshot.docs.forEach(doc => docs.push({id, color} = doc.data()));

                    const updateBatch = () => {
                        const batch = FIRESTORE.batch();
                        for (let i = 0; i < Math.min(docs.length, 500); i++) {
                            const doc = docs.pop(); let color = doc.color;
                            if (doc.color === old.color) color = now.color;
                            let updates = {color};
                            if (removed.length > 0) {
                                updates.users = FieldValue.arrayRemove(...removed);
                                removed.forEach(user => updates[`access.${user}`] = FieldValue.delete());
                            }
                            batch.update(TRANSACTIONS.doc(doc.id), updates);
                        }
                        batch.commit().then(() => {
                            if (docs.length > 0) updateBatch();
                            else resolve();
                        });
                    }

                    if (docs.length > 0) updateBatch();
                    else resolve();
                })
            })

        return null;

    });

exports.accountDeleted = functions.firestore
    .document('accounts/{id}')
    .onDelete((snap, context) => {

        return TRANSACTIONS.where("account", "==", snap.id).get().then(snapshot => {

            // Delete all transactions using firebase batch. limit(500) is used to avoid exceeding the 500 write limit
            return new Promise(resolve => {

                const ids = [];
                snapshot.docs.forEach(doc => ids.push(doc.id));

                const deleteBatch = () => {
                    const batch = FIRESTORE.batch();
                    for (let i = 0; i < Math.min(ids.length, 500); i++) {
                        const docID = ids.pop();
                        batch.delete(TRANSACTIONS.doc(docID));
                    }
                    batch.commit().then(() => {
                        if (ids.length > 0) deleteBatch();
                        else resolve();
                    });
                }

                deleteBatch();

            }).then(() => res.sendStatus(200)).catch(res.send)

        })

    });

exports.transactionAdded = functions.firestore
    .document('transactions/{id}')
    .onCreate((snap, context) => {
        const data = snap.data();
        if (!data.account) return null;
        let update = {[`balance.${data.currency}`]: FieldValue.increment(data.amount - (data.fee || 0))};
        if (data.tags.length>0) update.tags = FieldValue.arrayUnion(...data.tags)
        return ACCOUNTS.doc(data.account).update(update);
    });

exports.transactionDeleted = functions.firestore
    .document('transactions/{id}')
    .onDelete((snap, context) => {
        const data = snap.data();
        if (!data.account) return null;
        // check if account exists
        return ACCOUNTS.doc(data.account).get().then(snapshot => {
            if (!snapshot.exists) return null;
            return snapshot.ref.update({
                [`balance.${data.currency}`]: FieldValue.increment(-data.amount + (data.fee || 0))
            });
        })
    });

const sendNotification = (subject, message, to) => {
    console.log("Sending Email", to, subject, message);

    if (!to.token && !to.email && to.id) {
        USERS.doc(to.id).get().then(snapshot => {
            const user = snapshot.data();
            if (user) return sendNotification(subject, message, {token: user.token, email: user.email});
        })
    }

    if (to.token) {
        logger.info("Test Notification", {structuredData: true});
        return messaging.send({
            notification: {
                title: subject,
                body: message
            },
            data: {
                url: "https://fundtrace.web.app/notification",
                tag: "notification",
            },
            token: to.token,
            webpush: {
                fcm_options: {
                    link: "https://fundtrace.web.app/notification",
                }
            }
        }).catch(error => {
            logger.error("Error sending notification:", error, {structuredData: true});
        });
    }

    if (to.email)
        return new Promise((resolve, reject) => {
            return nodeMailer.createTransport(emailConfig).sendMail({
                from: '"FundTrace" <noreply@fundtrace.web.app>',
                to: to.email, subject,
                text: message,
                html: message
            }, (error, info) => {
                if (error) reject(error);
                return resolve(info);
            });
        });
}

exports.notification = functions.firestore
    .document('notifications/{id}').onCreate((snap, context) => {
        const notification = snap.data();
        if (notification.user) return sendNotification(notification.title, notification.message, {email: notification.contact});
        return Promise.all([USERS.where("email", "==", notification.contact).get(), CIRCLES.where(`${notification.from.id}.email`, '==', notification.contact)]).then(([snapshot, circle]) => {
            const user = snapshot.docs[0]?.data();

            let updates = {"delete": new Date().setDate(new Date().getDate() + 14)}; let notify = true;
            if ((circle.docs?.length > 0 && notification.target.startsWith("circles/")) || notification.from.email === user?.email) {
                updates.result = "Already invited"
                notify = false;
            }
            if (snapshot.docs?.length > 0) {
                updates = {...updates,
                    users: FieldValue.arrayUnion(user.id),
                    [`access.${user.id}`]: 4,
                    to: {id: user.id, displayName: user.displayName, photoURL: user.photoURL, email: user.email}
                }
            }
            return NOTIFICATIONS.doc(snap.id).update(updates).then(() => {
                if (notify) return sendNotification(notification.title, notification.message, {token: user?.token, email: user?.token? null: notification.contact});
                else return null;
            });
        }).catch(console.error);
    });

exports.notificationUpdated = functions.firestore
    .document('notifications/{id}').onUpdate((snap, context) => {
        const notification = snap.after.data();
        if (notification.result === "accepted") {
            console.log(notification.id, "Notification Accepted", notification.target);

            const circle = notification.users.sort().join("-");
            return CIRCLES.doc(circle).get().then(snapshot => {

                const batch = FIRESTORE.batch();

                if (!snapshot.exists)
                    batch.set(CIRCLES.doc(circle), {
                        id: circle,
                        users: notification.users,
                        [notification.from.id]: notification.to,
                        [notification.to.id]: notification.from,
                        created: FieldValue.serverTimestamp(),
                        type: "circles",
                    });

                if (!notification.target.startsWith("circles/"))
                    batch.update(FIRESTORE.doc(notification.target), {users: FieldValue.arrayUnion(notification.to.id)});

                return batch.commit().then(() => {
                    return sendNotification("Accepted", "Your request has been accepted", {id: notification.from.id});
                });

            }).catch(console.error);
        }

        if (notification.result === "rejected") {
            console.log(notification.id, "Notification Rejected", notification.target);
            return sendNotification("Rejected", "Your request has been rejected", {id: notification.from.id});
        }

        return null;
    });

exports.test = onRequest((req, res) => {

    const request = {
        headers: req.headers,
        body: req.body,
        query: req.query,
        params: req.params,
        url: req.url,
        IP: req.ip,
        source: req.get('user-agent'),
        method: req.method,
        path: req.path,
        protocol: req.protocol,
        secure: req.secure,
    }
    console.log("Test Request", request);
    res.send(request);

});