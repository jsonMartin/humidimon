require('dotenv').config();

const { formatISO9075 } = require('date-fns');

const { throttle } = require('lodash');

const at = require('run-at');

const sensor = require('node-dht-sensor').promises;
const lcd = new (require('raspberrypi-liquid-crystal'))(1, 0x27, 16, 2);

const express = require('express');
const app = express();
app.set('view engine', 'pug');

const twilio = new require('twilio')(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

const log4js = require('log4js');
log4js.configure({
  appenders: { humidimon: { type: 'file', filename: 'humidimon.log' }, console: { type: 'console' } },
  categories: { default: { appenders: ['console', 'humidimon'], level: 'trace' } },
});
const logger = log4js.getLogger('humidimon');
const ObjectsToCsv = require('objects-to-csv');

const PORT = process.env.PORT;

const SENSOR_TYPE = 22;
const SENSORS = {
  Inside: 4,
  Outside: 21,
};
const SENSOR_INTERVAL = 2500; // in MS
const CSV_INTERVAL = 60000; // in MS

// Notification settings
const NOTIFICATION_THROTTLE_TIME = 1800000; // 30 min (in ms)
const LOWER_TEMPERATURE_LIMIT = 72; // In degrees Fahrenheit
const UPPER_TEMPERATURE_LIMIT = 80; // In degrees Fahrenheit
const LOWER_HUMIDITY_LIMIT = 70; // In percent
const UPPER_HUMIDITY_LIMIT = 99; // In percent

const convertCelsiusToFahrenheit = (celsius) => (celsius * 9) / 5 + 32;
const formatNumber = (number) => parseFloat(number.toFixed(2));

function lcdOn() {
  lcd.displaySync();
  lcdEnabled = true;
}

function lcdOff() {
  lcd.noDisplaySync();
  lcdEnabled = false;
}

let lcdEnabled = false;
let lcdTimerEnabled = process.env.LCD_TIMER;

function setLcdTimers() {
  const lcdTimerOn = () => {
    if (lcdTimerEnabled) {
      lcdOn();
      logger.info('TIMER: Turning on LCD');
      setTimeout(() => {
        at(process.env.LCD_TIMER_ON_TIME, lcdTimerOn);
      }, 90000); // Wait until the next minute, to prevent retriggering an alarm for the same minute
    }
  };

  const lcdTimerOff = () => {
    if (lcdTimerEnabled) {
      lcdOff();
      logger.info('TIMER: Turning off LCD');
      setTimeout(() => {
        at(process.env.LCD_TIMER_OFF_TIME, lcdTimerOff);
      }, 90000); // Wait until the next minute, to prevent retriggering an alarm for the same minute
    }
  };

  at(process.env.LCD_TIMER_ON_TIME, lcdTimerOn);
  at(process.env.LCD_TIMER_OFF_TIME, lcdTimerOff);
  logger.info(`Set ON Timer for ${process.env.LCD_TIMER_ON_TIME}\nOFF Timer for ${process.env.LCD_TIMER_OFF_TIME}`);
}

const statsString = (sep = '\n') => {
  let statsString = '';

  for (let stat in stats) {
    if (typeof stats[stat] === 'number') statsString += `${stat}: ${formatNumber(stats[stat])}${sep}`;
    else statsString += `${stat}: ${stats[stat]}${sep}`;
  }

  return statsString;
};

const stats = {
  max_temperature: -Infinity,
  max_humidity: -Infinity,
  min_temperature: Infinity,
  min_humidity: Infinity,
  avg_temperature: undefined,
  avg_humidity: undefined,
  lastUpdated: undefined,
  uptime: formatISO9075(Date.now()),
};
let [humidity, temperature, outsideHumidity, outsideTemperature] = [0, 0, 0, 0];
async function readSensors() {
  try {
    // Read Inside Sensor
    let insideSensorResult = await sensor.read(SENSOR_TYPE, SENSORS['Inside']);
    temperature = convertCelsiusToFahrenheit(insideSensorResult.temperature);
    humidity = insideSensorResult.humidity;

    // Read Outside Sensor
    let outdoorSensorResult = await sensor.read(SENSOR_TYPE, SENSORS['Outside']);
    outsideTemperature = convertCelsiusToFahrenheit(outdoorSensorResult.temperature);
    outsideHumidity = outdoorSensorResult.humidity;

    // Error Checking
    if (!humidity || !temperature) throw Error('Sensor data missing');

    if (!stats['avg_temperature']) stats['avg_temperature'] = temperature;
    if (!stats['avg_humidity']) stats['avg_humidity'] = humidity;

    // Track stats
    stats['max_temperature'] = Math.max(stats['max_temperature'], temperature);
    stats['min_temperature'] = Math.min(stats['min_temperature'], temperature);
    stats['max_humidity'] = Math.max(stats['max_humidity'], humidity);
    stats['min_humidity'] = Math.min(stats['min_humidity'], humidity);
    stats['avg_temperature'] = (stats['avg_temperature'] + temperature) / 2;
    stats['avg_humidity'] = (stats['avg_humidity'] + humidity) / 2;

    stats['lastUpdated'] = formatISO9075(Date.now());

    logger.info(`
-------------------------------------------------------------------------------
Temperature: ${formatNumber(temperature)}F | Humidity: ${formatNumber(humidity)}%
Outside Temp: ${formatNumber(outsideTemperature)}F | Outside Humidity: ${formatNumber(outsideHumidity)}%
----------------------------------------------
LCD Backlight: ${lcdEnabled ? 'on' : 'off'}
${statsString()}-------------------------------------------------------------------------------`);
  } catch (error) {
    logger.error('Error');
  }
}

async function logToCSV() {
  const csv = new ObjectsToCsv([
    {
      time: formatISO9075(Date.now()),
      temperature: formatNumber(temperature),
      humidity: formatNumber(humidity),
      outsideTemperature: formatNumber(outsideTemperature),
      outsideHumidity: formatNumber(outsideHumidity),
    },
  ]);

  await csv.toDisk('./humidimon.csv', { append: true });
  logger.info('Successfully wrote to CSV file');
}

function writeSensorDataToLCD(line1 = '', line2 = '') {
  lcd.printLineSync(0, line1);
  lcd.printLineSync(1, line2);
}

const sendHumidityAlert = throttle((body) => sendText(body), NOTIFICATION_THROTTLE_TIME);
const sendTemperatureAlert = throttle((body) => sendText(body), NOTIFICATION_THROTTLE_TIME);

const notifyIfTemperatureOutOfRange = () => {
  if (temperature <= LOWER_TEMPERATURE_LIMIT) sendTemperatureAlert(`Temperature has fallen BELOW threshold: ${temperature.toFixed(2)} F`);
  else if (temperature >= UPPER_TEMPERATURE_LIMIT) sendTemperatureAlert(`Temperature has risen ABOVE threshold: ${temperature.toFixed(2)} F`);
};

const notifyIfHumidityOutOfRange = () => {
  if (humidity <= LOWER_HUMIDITY_LIMIT) sendHumidityAlert(`Humidity has fallen BELOW threshold: ${humidity.toFixed(2)}%`);
  else if (humidity >= UPPER_HUMIDITY_LIMIT) sendHumidityAlert(`Humidity has risen ABOVE threshold: ${humidity.toFixed(2)}%`);
};

const sensorTriggers = [notifyIfTemperatureOutOfRange, notifyIfHumidityOutOfRange]; // List of functions to be ran every sensor loop

async function sensorLoop() {
  await readSensors();
  writeSensorDataToLCD(`Temp:     ${temperature.toFixed(2)}F`, `Humidity: ${humidity.toFixed(2)}%`);

  for (sensorTrigger of sensorTriggers) {
    sensorTrigger(); // Run Sensor Trigger Hooks
  }
}

async function sendText(body = '') {
  logger.info('Attempting to send text...');

  let result = await twilio.messages.create({
    body,
    to: process.env.TWILIO_SEND_TO_NUMBER,
    from: process.env.TWILIO_SEND_FROM_NUMBER,
  });

  if (!result.errorCode) logger.info(`Successfully sent text with contents: ${result.body}`);
  else logger.error(`Error sending text: ${result.errorCode}`);
}

function server() {
  app.get('/', (request, response) => {
    if (!temperature || !humidity) response.send(`<h1>Still loading, try again</h1>`);
    else
      response.render('index', {
        temperature: temperature.toFixed(2),
        humidity: humidity.toFixed(2),
        outsideHumidity: outsideHumidity.toFixed(2),
        outsideTemperature: outsideTemperature.toFixed(2),
        stats,
        lcdEnabled,
      });
  });

  app.get('/led/off', (request, response) => {
    lcdOff();
    response.render('ledStatus', { lcdEnabled });
  });

  app.get('/led/on', (request, response) => {
    lcdOn();
    response.render('ledStatus', { lcdEnabled });
  });

  app.listen(PORT, () => {
    logger.info(`Server started, listening on ${PORT}`);
  });
}
function init() {
  sensor.setMaxRetries(10);
  sensor.initialize(22, 4);
  sensor.initialize(22, 21);

  lcd.beginSync(); // Required to initialize display before using
  lcd.displaySync(); // Turns on the display
  lcdEnabled = true;
  setLcdTimers();
}

async function main() {
  init();
  server();

  setInterval(sensorLoop, SENSOR_INTERVAL);
  setInterval(logToCSV, CSV_INTERVAL);
  sendText('Humidimon successfully started');
}

main();
