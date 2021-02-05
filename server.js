require('dotenv').config();

const { formatISO9075 } = require('date-fns');

const { throttle } = require('lodash');

const at = require('run-at');
const date = require('date.js');

const rpio = require('rpio');
const POWER_RELAY_PIN = 11;

const sensor = require('node-dht-sensor').promises;
const lcd = new (require('raspberrypi-liquid-crystal'))(1, 0x27, 16, 2);

const express = require('express');
const app = express();
app.set('view engine', 'pug');

const twilio = new require('twilio')(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

const log4js = require('log4js');
log4js.configure({
  appenders: {
    humidimon: { type: 'file', filename: 'humidimon.log' },
    console: { type: 'console', level: 'info' },
    humidimonFilter: {
      type: 'logLevelFilter',
      appender: 'humidimon',
      level: 'info',
    },
  },
  categories: {
    default: { appenders: ['console', 'humidimonFilter'], level: 'trace' },
  },
});
const logger = log4js.getLogger('humidimon');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_UPDATE_INTERVAL = 60000; // in MS

const PORT = process.env.PORT;

// DHT sensor configuration
const SENSOR_TYPE = 22; // 22 for DHT-22, 11 for DHT-11 sensor
const SENSORS = {
  // Contains the value of the GPIO data pin
  Inside: 4,
  Outside: 21,
};
const SENSOR_INTERVAL = 2500; // How long to poll sensor for updates, in MS

const MODE = 'humidifier'; // Choices for functionality: 'heater' or 'humidifier'

// Notification settings
const NOTIFICATION_THROTTLE_TIME = 1800000; // 30 min (in ms)
const NOTIFICATION_LOWER_TEMPERATURE_LIMIT = 68; // In degrees Fahrenheit
const NOTIFICATION_UPPER_TEMPERATURE_LIMIT = 74; // In degrees Fahrenheit
const NOTIFICATION_LOWER_HUMIDITY_LIMIT = 70; // In percent
const NOTIFICATION_UPPER_HUMIDITY_LIMIT = 99; // In percent

const convertCelsiusToFahrenheit = (celsius) => (celsius * 9) / 5 + 32;
const formatNumber = (number) => parseFloat(number.toFixed(2));

const getPowerRelayState = () => rpio.read(POWER_RELAY_PIN);
const setPowerRelayState = (on = false) => {
  rpio.write(POWER_RELAY_PIN, on ? rpio.HIGH : rpio.LOW);
};

let lcdEnabled = false;
let lcdTimerEnabled = process.env.LCD_TIMER;

const setLcdTimers = () => {
  const LCD_TIMER_ON_TIME = process.env.LCD_TIMER_ON_TIME;
  const LCD_TIMER_OFF_TIME = process.env.LCD_TIMER_OFF_TIME;
  const NEW_TIMER_DELAY = 90000; // ms

  const lcdTimerOn = () => {
    if (lcdTimerEnabled) {
      lcdOn();
      logger.info('TIMER: Turning on LCD');
      setTimeout(() => {
        logger.info('Setting new ON timer for:', date(LCD_TIMER_ON_TIME));
        at(LCD_TIMER_ON_TIME, lcdTimerOn);
      }, NEW_TIMER_DELAY); // Wait until the next minute, to prevent retriggering an alarm for the same minute
    }
  };

  const lcdTimerOff = () => {
    if (lcdTimerEnabled) {
      lcdOff();
      logger.info('TIMER: Turning off LCD');
      setTimeout(() => {
        logger.info('Setting new OFF timer for:', date(LCD_TIMER_OFF_TIME));
        at(LCD_TIMER_OFF_TIME, lcdTimerOff);
      }, NEW_TIMER_DELAY); // Wait until the next minute, to prevent retriggering an alarm for the same minute
    }
  };

  at(LCD_TIMER_ON_TIME, lcdTimerOn);
  at(LCD_TIMER_OFF_TIME, lcdTimerOff);
  logger.info(`Set ON Timer for ${LCD_TIMER_ON_TIME}\nOFF Timer for ${LCD_TIMER_OFF_TIME}`);
};

const lcdOn = () => {
  lcd.displaySync();
  lcdEnabled = true;
};

const lcdOff = () => {
  lcd.noDisplaySync();
  lcdEnabled = false;
};

const writeSensorDataToLCD = (line1 = '', line2 = '') => {
  lcd.printLineSync(0, line1);
  lcd.printLineSync(1, line2);
};

const formattedInfoString = () => `
-------------------------------------------------------------------------------
Temperature: ${formatNumber(temperature)}F | Humidity: ${formatNumber(humidity)}%
Outside Temp: ${formatNumber(outsideTemperature)}F | Outside Humidity: ${formatNumber(outsideHumidity)}%
----------------------------------------------
LCD Backlight: ${lcdEnabled ? 'on' : 'off'}
${statsString()}-------------------------------------------------------------------------------`;

const statsString = (sep = '\n') => {
  let statsString = '';

  for (let stat in stats) {
    if (typeof stats[stat] === 'number') statsString += `${stat}: ${formatNumber(stats[stat])}${sep}`;
    else statsString += `${stat}: ${stats[stat]}${sep}`;
  }

  return statsString;
};

const logToDB = async () => {
  try {
    const db = await open({
      filename: 'humidimon.db',
      driver: sqlite3.Database,
    });

    await db.run(
      'INSERT INTO sensorData (timestamp, temperature, humidity, outsideTemperature, outsideHumidity) VALUES (?, ?, ?, ?, ?)',
      stats['lastUpdated'],
      formatNumber(temperature),
      formatNumber(humidity),
      formatNumber(outsideTemperature),
      formatNumber(outsideHumidity)
    );

    logger.info('Successfully wrote to Database');
    logger.info(formattedInfoString());
  } catch (error) {
    logger.error('Error writing to database:', error);
  }
};

const sendText = async (body = '') => {
  logger.info('Attempting to send text...');

  let result = await twilio.messages.create({
    body,
    to: process.env.TWILIO_SEND_TO_NUMBER,
    from: process.env.TWILIO_SEND_FROM_NUMBER,
  });

  if (!result.errorCode) logger.info(`Successfully sent text with contents: ${result.body}`);
  else logger.error(`Error sending text: ${result.errorCode}`);
};

const sendHumidityAlert = throttle((body) => sendText(body), NOTIFICATION_THROTTLE_TIME);
const sendTemperatureAlert = throttle((body) => sendText(body), NOTIFICATION_THROTTLE_TIME);

const notifyIfTemperatureOutOfRangeTrigger = () => {
  if (temperature <= NOTIFICATION_LOWER_TEMPERATURE_LIMIT) sendTemperatureAlert(`Temperature has fallen BELOW threshold: ${temperature.toFixed(2)} F`);
  else if (temperature >= NOTIFICATION_UPPER_TEMPERATURE_LIMIT) sendTemperatureAlert(`Temperature has risen ABOVE threshold: ${temperature.toFixed(2)} F`);
};

const notifyIfHumidityOutOfRangeTrigger = () => {
  if (humidity <= NOTIFICATION_LOWER_HUMIDITY_LIMIT) sendHumidityAlert(`Humidity has fallen BELOW threshold: ${humidity.toFixed(2)}%`);
  else if (humidity >= NOTIFICATION_UPPER_HUMIDITY_LIMIT) sendHumidityAlert(`Humidity has risen ABOVE threshold: ${humidity.toFixed(2)}%`);
};

const turnOnHeaterTrigger = () => {
  const LOWER_TEMPERATURE_LIMIT = 76.5;

  if (temperature < LOWER_TEMPERATURE_LIMIT) {
    if (getPowerRelayState()) return;

    setPowerRelayState(true);
    logger.warn('Turning ON heater!');
    sendText(`Heater ON! Temp: ${temperature}, Limit: ${LOWER_TEMPERATURE_LIMIT}`);
  }
};

const turnOffHeaterTrigger = () => {
  const UPPER_TEMPERATURE_LIMIT = 78.5;

  if (temperature > UPPER_TEMPERATURE_LIMIT) {
    if (!getPowerRelayState()) return; // Abort if relay is already off

    setPowerRelayState(false);
    logger.warn('Turning OFF heater!');
    sendText(`Heater OFF! Temp: ${temperature}, Limit: ${UPPER_TEMPERATURE_LIMIT}`);
  }
};

const turnOnHumidifierTrigger = () => {
  const LOWER_HUMIDITY_LIMIT = 80;

  if (humidity < LOWER_HUMIDITY_LIMIT) {
    if (getPowerRelayState()) return;

    setPowerRelayState(true);
    logger.warn('Turning ON humidity!');
    sendText(`Humidifier ON! Humidity: ${humidity}%, Limit: ${LOWER_HUMIDITY_LIMIT}`);
  }
};

const turnOffHumidifierTrigger = () => {
  const UPPER_HUMIDITY_LIMIT = 95;

  if (humidity > UPPER_HUMIDITY_LIMIT) {
    if (!getPowerRelayState()) return;

    setPowerRelayState(false);
    logger.warn('Turning OFF humidifier!');
    sendText(`Humidifier OFF! Humidity: ${humiditiy}, Limit: ${UPPER_HUMIDITY_LIMIT}`);
  }
};

const sensorTriggers = MODE === 'heater' ? [notifyIfTemperatureOutOfRangeTrigger, notifyIfHumidityOutOfRangeTrigger, turnOnHeaterTrigger, turnOffHeaterTrigger] : [notifyIfTemperatureOutOfRangeTrigger, notifyIfHumidityOutOfRangeTrigger, turnOnHumidifierTrigger, turnOffHumidifierTrigger] // List of functions to be ran every sensor loop

const stats = {
  maxTemperature: -Infinity,
  maxHumidity: -Infinity,
  minTemperature: Infinity,
  minHumidity: Infinity,
  avgTemperature: null,
  avgHumidity: null,
  lastUpdated: null,
  powerSwitch: null,
  sensorReadCount: 0,
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

    if (!stats['avgTemperature']) stats['avgTemperature'] = temperature;
    if (!stats['avgHumidity']) stats['avgHumidity'] = humidity;

    // Track stats
    stats['maxTemperature'] = Math.max(stats['maxTemperature'], temperature);
    stats['minTemperature'] = Math.min(stats['minTemperature'], temperature);
    stats['maxHumidity'] = Math.max(stats['maxHumidity'], humidity);
    stats['minHumidity'] = Math.min(stats['minHumidity'], humidity);
    stats['avgTemperature'] = (stats['avgTemperature'] + temperature) / 2;
    stats['avgHumidity'] = (stats['avgHumidity'] + humidity) / 2;
    stats['powerSwitch'] = getPowerRelayState();

    stats['lastUpdated'] = formatISO9075(Date.now());

    stats['sensorReadCount']++ > 0 ? logger.debug(formattedInfoString()) : logger.info(formattedInfoString());
  } catch (error) {
    logger.error('Error:', error);
  }
}

async function sensorLoop() {
  await readSensors();
  writeSensorDataToLCD(`Temp:     ${temperature.toFixed(2)}F`, `Humidity: ${humidity.toFixed(2)}%`);

  for (sensorTrigger of sensorTriggers) {
    sensorTrigger(); // Run Sensor Trigger Hooks
  }
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
  rpio.open(POWER_RELAY_PIN, rpio.OUTPUT);

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
  setInterval(logToDB, DB_UPDATE_INTERVAL);
  sendText('Humidimon successfully started');
}

main();
